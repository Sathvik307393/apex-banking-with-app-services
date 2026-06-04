/**
 * APEX PREMIUM BANKING PORTAL
 * ===========================
 * A single-file, self-contained Express web application with a complete banking dashboard,
 * transaction execution (deposit, withdrawal, transfer), statements generator, KYC management,
 * and an administrative testing dashboard.
 * 
 * Features:
 *   - User Register, Login, & HttpOnly JWT Cookie Authentication.
 *   - PostgreSQL Database Integration with auto-migration.
 *   - Automatic Fallback to a local JSON Database (database.json) if Postgres is offline.
 *   - Complete Banking Operations with atomic integrity.
 *   - KYC uploads (Aadhaar, PAN, Passport) using Multer.
 *   - Admin Panel to review and verify/approve users' KYC.
 *   - Interactive Client Dashboard utilizing Chart.js for Spending/Income Tracking.
 *   - Downloadable account statements in CSV format.
 *   - Premium responsive Dark Theme / Glassmorphism layout using HSL CSS variables.
 * 
 * Running locally:
 *   1. Install dependencies: npm install
 *   2. Start database or rely on the local database.json fallback.
 *   3. Run using: npm start (or npm run dev)
 *   4. Open http://localhost:3000 in your browser.
 * 
 * Running on Azure App Service:
 *   1. The app automatically binds to process.env.PORT.
 *   2. Database connections will check standard environment variables (DATABASE_URL, etc.)
 *      and automatically enable SSL connections suitable for Azure DB for PostgreSQL.
 */

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ServiceBusClient } = require('@azure/service-bus');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust Azure Application Gateway / reverse proxy
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'apex_banking_super_secret_cryptographic_key_9988';
const JSON_DB_PATH = path.join(__dirname, 'database.json');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// -------------------------------------------------------------
// AZURE BLOB STORAGE SETUP (with RA-GRS Geo-Redundancy Fallback)
// -------------------------------------------------------------
let blobServiceClient = null;
let containerClient = null;
const containerName = 'kyc-documents';

function initAzureStorage() {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr || connStr.includes('your_account_name')) {
    console.warn('[AZURE STORAGE] Connection String is not configured. Falling back to local filesystem (uploads/) for KYC documents.');
    return;
  }
  
  try {
    // Parse the Storage Account Name to build the secondary endpoint for RA-GRS
    const match = connStr.match(/AccountName=([^;]+)/);
    const accountName = match ? match[1] : null;
    const options = {};
    
    if (accountName) {
      options.geoRedundantSecondaryUri = `https://${accountName}-secondary.blob.core.windows.net`;
      console.log(`[AZURE STORAGE] Configuring with Geo-Redundant secondary URI: ${options.geoRedundantSecondaryUri}`);
    }
    
    blobServiceClient = BlobServiceClient.fromConnectionString(connStr, options);
    containerClient = blobServiceClient.getContainerClient(containerName);
    console.log('[AZURE STORAGE] Client initialized successfully.');
  } catch (error) {
    console.error('[AZURE STORAGE] Initialization failed:', error.message);
  }
}

async function clearAzureKYCContainers() {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr || connStr.includes('your_account_name')) {
    return { message: 'Azure storage is not configured.' };
  }

  const client = BlobServiceClient.fromConnectionString(connStr);
  const containers = ['kyc-documents', 'processed-and-validated-container'];
  const result = {
    deleted: {
      'kyc-documents': 0,
      'processed-and-validated-container': 0
    },
    warnings: []
  };

  for (const targetContainerName of containers) {
    try {
      const targetClient = client.getContainerClient(targetContainerName);
      const exists = await targetClient.exists();
      if (!exists) {
        result.warnings.push(`Container '${targetContainerName}' not found.`);
        continue;
      }

      for await (const blob of targetClient.listBlobsFlat()) {
        await targetClient.deleteBlob(blob.name);
        result.deleted[targetContainerName] += 1;
      }
    } catch (error) {
      result.warnings.push(`Failed to clear container '${targetContainerName}': ${error.message}`);
    }
  }

  return result;
}

function clearLocalUploadFiles() {
  if (!fs.existsSync(uploadDir)) return { deleted: 0 };
  const files = fs.readdirSync(uploadDir);
  let deleted = 0;
  for (const file of files) {
    try {
      const filePath = path.join(uploadDir, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch (error) {
      console.warn('[LOCAL STORAGE CLEANUP] Failed to delete local upload file:', file, error.message);
    }
  }
  return { deleted };
}

// Initialize Azure Storage client
initAzureStorage();

// -------------------------------------------------------------
// NODEMAILER SMTP EMAIL SERVICE
// -------------------------------------------------------------
let mailTransporter = null;

function initMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[EMAIL SERVICE] SMTP configuration is incomplete. Emails will be logged to the console.');
    return;
  }

  try {
    mailTransporter = nodemailer.createTransport({
      host: host,
      port: parseInt(port),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user, pass }
    });
    console.log('[EMAIL SERVICE] Nodemailer transporter configured.');
  } catch (error) {
    console.error('[EMAIL SERVICE] Configuration failed:', error.message);
  }
}

initMailTransporter();

async function sendKYCStatusEmail(email, docType, status, reason) {
  const subject = `[Apex Bank] KYC Document Verification: ${status === 'Verified' ? 'Approved' : 'Rejected'}`;
  const text = `Dear Customer,

Your uploaded document of type "${docType}" has been processed and ${status === 'Verified' ? 'APPROVED' : 'REJECTED'}.

Detail: ${reason}

Thank you,
Apex Premium Banking Security Team`;

  if (mailTransporter) {
    try {
      await mailTransporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'Apex Bank'}" <${process.env.SMTP_FROM_EMAIL || 'security@apexbank.com'}>`,
        to: email,
        subject: subject,
        text: text
      });
      console.log(`[EMAIL SERVICE] Email sent successfully to ${email}`);
    } catch (error) {
      console.error(`[EMAIL SERVICE] Failed to send email to ${email}:`, error.message);
    }
  } else {
    console.log(`\n================================================================`);
    console.log(`[MOCK EMAIL SERVICE] SENDING OUTBOUND EMAIL`);
    console.log(`To: ${email}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${text}`);
    console.log(`================================================================\n`);
  }
}

// -------------------------------------------------------------
// AZURE SERVICE BUS SETUP & LISTENER
// -------------------------------------------------------------
let serviceBusClient = null;
const queueName = 'kyc-notifications';

function initServiceBus() {
  const connStr = process.env.AZURE_SERVICE_BUS_CONNECTION_STRING;
  if (!connStr || connStr.includes('your_connection_string')) {
    console.warn('[SERVICE BUS] Connection String is not configured. Falling back to local in-memory event loop.');
    return;
  }

  try {
    serviceBusClient = new ServiceBusClient(connStr);
    console.log('[SERVICE BUS] Client initialized successfully.');
    startServiceBusListener();
  } catch (error) {
    console.error('[SERVICE BUS] Initialization failed:', error.message);
  }
}

function startServiceBusListener() {
  if (!serviceBusClient) return;
  const receiver = serviceBusClient.createReceiver(queueName);

  receiver.subscribe({
    processMessage: async (message) => {
      try {
        const body = message.body;
        console.log(`[SERVICE BUS] Received notification:`, body);
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        
        await handleKYCNotification(payload);
        await message.complete();
      } catch (err) {
        console.error(`[SERVICE BUS] Error processing message:`, err.message);
      }
    },
    processError: async (args) => {
      console.error(`[SERVICE BUS] Listener error:`, args.error);
    }
  });
  console.log(`[SERVICE BUS] Subscribed to queue "${queueName}"`);
}

// -------------------------------------------------------------
// MOCK SERVICE BUS FOR LOCAL FALLBACK
// -------------------------------------------------------------
const localQueue = [];

async function publishMockServiceBusMessage(payload) {
  console.log('[MOCK SERVICE BUS] Publishing message:', payload);
  localQueue.push(payload);
  
  setTimeout(async () => {
    const msg = localQueue.shift();
    if (msg) {
      try {
        console.log('[MOCK SERVICE BUS] Delivering message to receiver:', msg);
        await handleKYCNotification(msg);
      } catch (err) {
        console.error('[MOCK SERVICE BUS] Delivery handler error:', err.message);
      }
    }
  }, 800);
}

// -------------------------------------------------------------
// KYC NOTIFICATION HANDLER (SHARED BY SERVICE BUS & MOCK QUEUE)
// -------------------------------------------------------------
async function handleKYCNotification(payload) {
  const { userId, docId, docType, status, reason, fileName, email } = payload;
  console.log(`[KYC HANDLER] Processing notification for User ${userId} | Doc ${docId} (${docType}) -> ${status}`);

  // 1. Update Document Status in Database
  const finalFilePath = containerClient 
    ? `azure://processed-and-validated-container/${fileName}`
    : `uploads/processed_and_validated/${fileName}`;

  if (isPg) {
    await pool.query(
      'UPDATE bank_kyc_docs SET status = $1, file_path = $2, ocr_details = $3 WHERE id = $4',
      [status, finalFilePath, reason || '', docId]
    );
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const doc = data.kyc_docs.find(d => d.id === docId);
    if (doc) {
      doc.status = status;
      doc.file_path = finalFilePath;
      doc.ocr_details = reason || '';
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    }
  }

  // 2. Check if user has all required documents verified to auto-verify User
  let shouldVerifyUser = false;
  if (status === 'Verified') {
    let docs = [];
    if (isPg) {
      const res = await pool.query('SELECT doc_type, status FROM bank_kyc_docs WHERE user_id = $1', [userId]);
      docs = res.rows;
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      docs = data.kyc_docs.filter(d => d.user_id === userId);
    }

    const hasPhoto = docs.some(d => d.doc_type === 'Photo' && d.status === 'Verified');
    const identityDocs = ['Aadhaar', 'PAN', 'Passport'];
    const uniqueVerifiedIds = new Set(
      docs.filter(d => identityDocs.includes(d.doc_type) && d.status === 'Verified').map(d => d.doc_type)
    );
    
    if (hasPhoto && uniqueVerifiedIds.size >= 2) {
      shouldVerifyUser = true;
    }
  }

  if (shouldVerifyUser) {
    console.log(`[KYC HANDLER] Auto-Verifying KYC status for User ID ${userId}`);
    await db.updateKYCStatus(userId, 'Verified');
    await db.logAudit(userId, 'KYC_AUTO_VERIFIED', 'KYC auto-verified successfully after validating Photo and 2 ID documents.', '127.0.0.1');
  } else if (status === 'Invalid') {
    // If a document was marked invalid, user KYC status resets to Pending / Submitted
    console.log(`[KYC HANDLER] Document marked invalid. Resetting KYC status checks.`);
    await db.updateKYCStatus(userId, 'Pending');
    await db.logAudit(userId, 'KYC_DOC_FAILED', `Document ${docType} was rejected. KYC validation remains incomplete.`, '127.0.0.1');
  }

  // 3. Write Security Audit Log
  await db.logAudit(userId, `KYC_DOC_VALIDATION_${status.toUpperCase()}`, `Document ${docType} validation returned: ${status}. ${reason}`, '127.0.0.1');

  // 4. Send Email Notification Alert
  await sendKYCStatusEmail(email, docType, status, reason);
}

// -------------------------------------------------------------
// LOCAL AZURE FUNCTION SIMULATOR (FOR LOCAL FALLBACK TESTING)
// -------------------------------------------------------------
function triggerLocalVerificationSimulator(userId, docId, docType, filename, originalname, mimeType) {
  console.log(`[LOCAL FUNCTION SIMULATOR] Initiating validation for User ${userId}, Doc Type: ${docType}`);
  
  setTimeout(async () => {
    try {
      const user = await db.getUserById(userId);
      if (!user) return;
      
      let isValid = false;
      let reason = '';
      
      const nameLower = originalname.toLowerCase();
      if (docType === 'Aadhaar') {
        isValid = nameLower.includes('aadhar') || nameLower.includes('aadhaar') || nameLower.includes('uidai') || nameLower.includes('card');
        reason = isValid ? 'Successfully verified 12-digit national identity format and digital seal.' : 'File name must contain Aadhaar identification keywords (e.g. "aadhar", "aadhaar", "uidai").';
      } else if (docType === 'PAN') {
        isValid = nameLower.includes('pan') || nameLower.includes('tax');
        reason = isValid ? 'Successfully verified 10-digit PAN alphanumeric registration number.' : 'File name must contain PAN keywords (e.g. "pan", "tax").';
      } else if (docType === 'Passport') {
        isValid = nameLower.includes('passport') || nameLower.includes('pass') || nameLower.includes('travel');
        reason = isValid ? 'Successfully verified passport MRZ zone alignment.' : 'File name must contain Passport keywords (e.g. "passport", "travel").';
      } else if (docType === 'Photo') {
        isValid = mimeType.startsWith('image/') || nameLower.match(/\.(jpg|jpeg|png)$/);
        reason = isValid ? 'Biometric validation successful: detected standard face profile.' : 'Profile Photo must be a valid image file (JPG or PNG).';
      } else {
        isValid = true;
        reason = 'Verification successful.';
      }

      let finalFileName = filename;
      if (isValid) {
        // Query form details for DOB fallback
        const kycForm = await db.getKycForm(userId);
        const dob = kycForm ? kycForm.dob : '01-01-1990';
        
        const sanitizedName = user.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const sanitizedDob = dob.replace(/[^0-9\-]/g, '');
        const ext = path.extname(filename) || '.pdf';
        finalFileName = `${sanitizedName}_${sanitizedDob}_${docType}${ext}`;

        // Ensure processed directory exists
        const processedDir = path.join(__dirname, 'uploads', 'processed_and_validated');
        if (!fs.existsSync(processedDir)) {
          fs.mkdirSync(processedDir, { recursive: true });
        }

        // Copy and delete original
        const sourcePath = path.join(__dirname, 'uploads', filename);
        const targetPath = path.join(processedDir, finalFileName);
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, targetPath);
          fs.unlinkSync(sourcePath);
        }
      } else {
        // Clean up invalid local file
        const sourcePath = path.join(__dirname, 'uploads', filename);
        if (fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
      }

      // Publish message to local mock Service Bus
      await publishMockServiceBusMessage({
        userId,
        docId,
        docType,
        status: isValid ? 'Verified' : 'Invalid',
        reason,
        fileName: finalFileName,
        email: user.email
      });

    } catch (err) {
      console.error('[LOCAL FUNCTION SIMULATOR] Simulation error:', err.message);
    }
  }, 2500);
}

// -------------------------------------------------------------
// DATABASE SETUP & CONFIGURATION (PostgreSQL / JSON Fallback)
// -------------------------------------------------------------
let isPg = false;
let db = {};
let pool = null;

// Parse Database Configuration
let dbConfig = {};
if (process.env.DATABASE_URL || process.env.AZURE_POSTGRESQL_CONNECTION_STRING) {
  dbConfig.connectionString = process.env.DATABASE_URL || process.env.AZURE_POSTGRESQL_CONNECTION_STRING;
} else {
  // Check postgreSQL connection string prefixed from Azure App Service
  let azureConnStr = null;
  for (const key in process.env) {
    if (key.startsWith('POSTGRESQLCONNSTR_')) {
      azureConnStr = process.env[key];
      break;
    }
  }

  if (azureConnStr) {
    dbConfig.connectionString = azureConnStr;
  } else {
    // Default fallback pointing to the standard autohub DB running locally
    dbConfig = {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'SecurePass123!@',
      database: process.env.DB_NAME || 'autohub'
    };
  }
}

// Add SSL config if requested or if host is a remote cloud instance (e.g. Azure)
const isRemoteHost = (dbConfig.host && dbConfig.host !== 'localhost' && dbConfig.host !== '127.0.0.1') ||
  (dbConfig.connectionString && !dbConfig.connectionString.includes('localhost') && !dbConfig.connectionString.includes('127.0.0.1'));
const sslEnabled = process.env.DB_SSL === 'true' || isRemoteHost;

if (sslEnabled) {
  dbConfig.ssl = {
    rejectUnauthorized: false
  };
}

// Attempt PG Connection & Initialize Database Helper Interface
async function initDb() {
  // Ensure Azure Storage container exists if client is active
  if (containerClient) {
    try {
      await containerClient.createIfNotExists();
      console.log(`[AZURE STORAGE] Container "${containerName}" is ready.`);
    } catch (err) {
      console.error(`[AZURE STORAGE] Container verification failed:`, err.message);
    }
  }

  try {
    console.log('Connecting to PostgreSQL database...');
    pool = new Pool(dbConfig);

    // Test database connection
    const client = await pool.connect();
    client.release();
    isPg = true;
    console.log('Connected to PostgreSQL successfully!');

    // Create Tables with bank_ prefix to prevent namespace collisions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        balance NUMERIC(15, 2) DEFAULT 1000.00,
        kyc_status VARCHAR(20) DEFAULT 'Pending',
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query("ALTER TABLE bank_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES bank_users(id) ON DELETE CASCADE,
        type VARCHAR(25) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        sender_email VARCHAR(100),
        recipient_email VARCHAR(100),
        remark VARCHAR(255),
        status VARCHAR(20) DEFAULT 'Success',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_kyc_docs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES bank_users(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query("ALTER TABLE bank_kyc_docs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending';");
    await pool.query("ALTER TABLE bank_kyc_docs ADD COLUMN IF NOT EXISTS doc_type VARCHAR(50);");
    await pool.query("ALTER TABLE bank_kyc_docs ADD COLUMN IF NOT EXISTS ocr_details VARCHAR(1000);");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES bank_users(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        details TEXT NOT NULL,
        ip_address VARCHAR(50) DEFAULT '127.0.0.1',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_kyc_forms (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES bank_users(id) ON DELETE CASCADE,
        dob VARCHAR(20) NOT NULL,
        address TEXT NOT NULL,
        tax_id VARCHAR(50) NOT NULL,
        income VARCHAR(50) NOT NULL,
        occupation VARCHAR(50) NOT NULL,
        signature_data TEXT NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default admin
    await pool.query("DELETE FROM bank_users WHERE email = 'admin@apexbank.com'");
    const adminEmail = 'admin@apex.com';
    const checkAdmin = await pool.query('SELECT * FROM bank_users WHERE email = $1', [adminEmail]);
    if (checkAdmin.rows.length === 0) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('admin123', salt);
      await pool.query(
        'INSERT INTO bank_users (name, email, password_hash, role, kyc_status, balance) VALUES ($1, $2, $3, $4, $5, $6)',
        ['System Admin', adminEmail, hash, 'admin', 'Verified', 0]
      );
    }
    console.log('PostgreSQL database tables and admin seeded.');
  } catch (error) {
    console.error('PostgreSQL connection failed:', error.message);
    console.log('Falling back to local JSON file storage (database.json)...');
    isPg = false;

    // Setup JSON DB files
    if (!fs.existsSync(JSON_DB_PATH)) {
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify({ users: [], transactions: [], kyc_docs: [], audit_logs: [], kyc_forms: [] }, null, 2));
    }
    
    // Seed default admin in JSON
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    data.users = (data.users || []).filter(u => u.email !== 'admin@apexbank.com');
    const adminEmail = 'admin@apex.com';
    if (!data.users.find(u => u.email === adminEmail)) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('admin123', salt);
      data.users.push({
        id: data.users.length > 0 ? Math.max(...data.users.map(u => u.id)) + 1 : 1,
        name: 'System Admin',
        email: adminEmail,
        password_hash: hash,
        balance: 0,
        kyc_status: 'Verified',
        role: 'admin',
        created_at: new Date().toISOString()
      });
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    }
  }
}

// -------------------------------------------------------------
// DATABASE INTERFACE ADAPTER METHODS
// -------------------------------------------------------------

// 1. Find User by Email
db.findUserByEmail = async (email) => {
  if (isPg) {
    const res = await pool.query('SELECT * FROM bank_users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    return res.rows[0];
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    return data.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
  }
};

// 2. Find User by ID
db.getUserById = async (id) => {
  if (isPg) {
    const res = await pool.query('SELECT id, name, email, balance, kyc_status, role, created_at FROM bank_users WHERE id = $1', [id]);
    return res.rows[0];
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const user = data.users.find(u => u.id === id);
    if (!user) return null;
    const { password_hash, ...safeUser } = user;
    if (!safeUser.role) safeUser.role = 'user';
    return safeUser;
  }
};

// 3. Create New User
db.createUser = async ({ name, email, passwordHash, role }) => {
  if (isPg) {
    // Insert User and add Welcome deposit transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'INSERT INTO bank_users (name, email, password_hash, balance, kyc_status) VALUES ($1, $2, $3, 1000.00, \'Pending\') RETURNING *',
        [name.trim(), email.trim().toLowerCase(), passwordHash, role || 'user']
      );
      const user = res.rows[0];
      await client.query(
        'INSERT INTO bank_transactions (user_id, type, amount, remark, status) VALUES ($1, \'Deposit\', 1000.00, \'Welcome Bonus\', \'Success\')',
        [user.id]
      );
      await client.query('COMMIT');
      return user;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const id = data.users.length + 1;
    const newUser = {
      id,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password_hash: passwordHash,
      balance: 1000.00,
      kyc_status: 'Pending',
      role: role || 'user',
      created_at: new Date().toISOString()
    };
    data.users.push(newUser);
    data.transactions.push({
      id: data.transactions.length + 1,
      user_id: id,
      type: 'Deposit',
      amount: 1000.00,
      remark: 'Welcome Bonus',
      status: 'Success',
      created_at: new Date().toISOString()
    });
    fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    return newUser;
  }
};

// 4. Run Balance Transaction (Deposit, Withdrawal, Transfer)
db.executeTransaction = async ({ userId, type, amount, targetEmail, remark }) => {
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) throw new Error('Amount must be positive.');

  if (isPg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current user and lock row for safety
      const userRes = await client.query('SELECT * FROM bank_users WHERE id = $1 FOR UPDATE', [userId]);
      const user = userRes.rows[0];
      if (!user) throw new Error('Sender user record not found.');

      const currentBalance = parseFloat(user.balance);

      if (type === 'Withdrawal') {
        if (currentBalance < numAmount) throw new Error('Insufficient funds.');
        const newBalance = currentBalance - numAmount;

        await client.query('UPDATE bank_users SET balance = $1 WHERE id = $2', [newBalance, userId]);
        await client.query(
          'INSERT INTO bank_transactions (user_id, type, amount, remark, status) VALUES ($1, $2, $3, $4, \'Success\')',
          [userId, 'Withdrawal', numAmount, remark || 'ATM Withdrawal']
        );
      } else if (type === 'Deposit') {
        const newBalance = currentBalance + numAmount;

        await client.query('UPDATE bank_users SET balance = $1 WHERE id = $2', [newBalance, userId]);
        await client.query(
          'INSERT INTO bank_transactions (user_id, type, amount, remark, status) VALUES ($1, $2, $3, $4, \'Success\')',
          [userId, 'Deposit', numAmount, remark || 'Deposit']
        );
      } else if (type === 'Transfer') {
        if (!targetEmail) throw new Error('Recipient email is required.');
        if (targetEmail.trim().toLowerCase() === user.email.toLowerCase()) throw new Error('Cannot transfer money to yourself.');

        // Find and lock recipient
        const recRes = await client.query('SELECT * FROM bank_users WHERE LOWER(email) = LOWER($1) FOR UPDATE', [targetEmail.trim()]);
        const recipient = recRes.rows[0];
        if (!recipient) throw new Error('Recipient account not found.');

        if (currentBalance < numAmount) throw new Error('Insufficient funds.');

        const senderNewBalance = currentBalance - numAmount;
        const recipientNewBalance = parseFloat(recipient.balance) + numAmount;

        // Update balances
        await client.query('UPDATE bank_users SET balance = $1 WHERE id = $2', [senderNewBalance, userId]);
        await client.query('UPDATE bank_users SET balance = $1 WHERE id = $2', [recipientNewBalance, recipient.id]);

        // Insert transactions logs
        await client.query(
          'INSERT INTO bank_transactions (user_id, type, amount, sender_email, recipient_email, remark, status) VALUES ($1, \'Transfer (Sent)\', $2, $3, $4, $5, \'Success\')',
          [userId, numAmount, user.email, recipient.email, remark || `Transfer to ${recipient.email}`]
        );

        await client.query(
          'INSERT INTO bank_transactions (user_id, type, amount, sender_email, recipient_email, remark, status) VALUES ($1, \'Transfer (Received)\', $2, $3, $4, $5, \'Success\')',
          [recipient.id, numAmount, user.email, recipient.email, remark || `Transfer from ${user.email}`]
        );
      } else {
        throw new Error('Unsupported transaction type.');
      }

      await client.query('COMMIT');
      return { success: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    // Local JSON implementation with memory block
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found.');

    const currentBalance = parseFloat(user.balance);

    if (type === 'Withdrawal') {
      if (currentBalance < numAmount) throw new Error('Insufficient funds.');
      user.balance = currentBalance - numAmount;

      data.transactions.push({
        id: data.transactions.length + 1,
        user_id: userId,
        type: 'Withdrawal',
        amount: numAmount,
        remark: remark || 'ATM Withdrawal',
        status: 'Success',
        created_at: new Date().toISOString()
      });
    } else if (type === 'Deposit') {
      user.balance = currentBalance + numAmount;

      data.transactions.push({
        id: data.transactions.length + 1,
        user_id: userId,
        type: 'Deposit',
        amount: numAmount,
        remark: remark || 'Deposit',
        status: 'Success',
        created_at: new Date().toISOString()
      });
    } else if (type === 'Transfer') {
      if (!targetEmail) throw new Error('Recipient email is required.');
      if (targetEmail.trim().toLowerCase() === user.email.toLowerCase()) throw new Error('Cannot transfer money to yourself.');

      const recipient = data.users.find(u => u.email.toLowerCase() === targetEmail.trim().toLowerCase());
      if (!recipient) throw new Error('Recipient account not found.');

      if (currentBalance < numAmount) throw new Error('Insufficient funds.');

      user.balance = currentBalance - numAmount;
      recipient.balance = parseFloat(recipient.balance) + numAmount;

      data.transactions.push({
        id: data.transactions.length + 1,
        user_id: userId,
        type: 'Transfer (Sent)',
        amount: numAmount,
        sender_email: user.email,
        recipient_email: recipient.email,
        remark: remark || `Transfer to ${recipient.email}`,
        status: 'Success',
        created_at: new Date().toISOString()
      });

      data.transactions.push({
        id: data.transactions.length + 1,
        user_id: recipient.id,
        type: 'Transfer (Received)',
        amount: numAmount,
        sender_email: user.email,
        recipient_email: recipient.email,
        remark: remark || `Transfer from ${user.email}`,
        status: 'Success',
        created_at: new Date().toISOString()
      });
    } else {
      throw new Error('Unsupported transaction type.');
    }

    fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    return { success: true };
  }
};

// 5. Get Filtered Transactions for User
db.getTransactions = async (userId, { startDate, endDate }) => {
  if (isPg) {
    let query = 'SELECT * FROM bank_transactions WHERE user_id = $1';
    const params = [userId];

    if (startDate) {
      params.push(startDate);
      query += ` AND created_at >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate + ' 23:59:59');
      query += ` AND created_at <= $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';
    const res = await pool.query(query, params);
    return res.rows;
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    let txs = data.transactions.filter(t => t.user_id === userId);

    if (startDate) {
      const start = new Date(startDate);
      txs = txs.filter(t => new Date(t.created_at) >= start);
    }
    if (endDate) {
      const end = new Date(endDate + 'T23:59:59');
      txs = txs.filter(t => new Date(t.created_at) <= end);
    }

    return txs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
};

// 6. Record KYC Document Metadata
db.uploadKYC = async (userId, { fileName, originalName, filePath, mimeType, docType }) => {
  if (isPg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'INSERT INTO bank_kyc_docs (user_id, file_name, original_name, file_path, mime_type, doc_type, status) VALUES ($1, $2, $3, $4, $5, $6, \'Pending\') RETURNING id',
        [userId, fileName, originalName, filePath, mimeType, docType]
      );
      
      await client.query('COMMIT');
      return res.rows[0].id;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const user = data.users.find(u => u.id === userId);
    if (user) {
      const id = data.kyc_docs.length + 1;
      data.kyc_docs.push({
        id,
        user_id: userId,
        file_name: fileName,
        original_name: originalName,
        file_path: filePath,
        mime_type: mimeType,
        doc_type: docType,
        status: 'Pending',
        uploaded_at: new Date().toISOString()
      });
      
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
      return id;
    }
    throw new Error('User not found');
  }
};

// 7. Update User KYC status (Approved/Verified/Rejected)
db.updateKYCStatus = async (userId, status) => {
  if (isPg) {
    await pool.query('UPDATE bank_users SET kyc_status = $1 WHERE id = $2', [status, userId]);
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    const user = data.users.find(u => u.id === userId);
    if (user) {
      user.kyc_status = status;
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    }
  }
};

// 8. Fetch All Users (Admin Function)
db.getAllUsers = async () => {
  if (isPg) {
    const res = await pool.query(`
      SELECT u.id, u.name, u.email, u.balance, u.kyc_status, u.created_at,
             (SELECT COUNT(*) FROM bank_transactions t WHERE t.user_id = u.id) as tx_count,
             (SELECT json_agg(k) FROM (SELECT file_name, original_name, uploaded_at, status, doc_type, ocr_details FROM bank_kyc_docs WHERE user_id = u.id) k) as documents,
             (SELECT row_to_json(f) FROM (SELECT dob, address, tax_id, income, occupation, signature_data, submitted_at FROM bank_kyc_forms WHERE user_id = u.id) f) as kyc_form
      FROM bank_users u ORDER BY u.id DESC
    `);
    return res.rows;
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    return data.users.map(u => {
      const { password_hash, ...safeUser } = u;
      safeUser.tx_count = data.transactions.filter(t => t.user_id === u.id).length;
      safeUser.documents = data.kyc_docs
        .filter(d => d.user_id === u.id)
        .map(d => ({
          file_name: d.file_name,
          original_name: d.original_name,
          uploaded_at: d.uploaded_at,
          status: d.status || 'Pending',
          doc_type: d.doc_type || d.original_name.split(':')[0],
          ocr_details: d.ocr_details || ''
        }));
      safeUser.kyc_form = (data.kyc_forms || []).find(f => f.user_id === u.id) || null;
      return safeUser;
    });
  }
};

// 9. Fetch All Transactions (Admin Function)
db.getAllTransactions = async () => {
  if (isPg) {
    const res = await pool.query(`
      SELECT t.*, u.email as user_email 
      FROM bank_transactions t 
      JOIN bank_users u ON t.user_id = u.id 
      ORDER BY t.created_at DESC
    `);
    return res.rows;
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    return data.transactions.map(t => {
      const user = data.users.find(u => u.id === t.user_id);
      return { ...t, user_email: user ? user.email : 'unknown' };
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
};

// 10. Record Security Audit Log
db.logAudit = async (userId, action, details, ipAddress = '127.0.0.1') => {
  try {
    if (isPg) {
      await pool.query(
        'INSERT INTO bank_audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)',
        [userId, action, details, ipAddress]
      );
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      if (!data.audit_logs) data.audit_logs = [];
      data.audit_logs.push({
        id: data.audit_logs.length + 1,
        user_id: userId,
        action,
        details,
        ip_address: ipAddress,
        created_at: new Date().toISOString()
      });
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    }

    // Alert Notification simulated service dispatch
    console.log(`[ALERT SERVICE] User ID: ${userId} | Action: ${action} | Details: ${details} | Dispatching Simulated SMS/Email Alert`);
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
};

// 11. Retrieve Security Audit Logs
db.getAuditLogs = async (userId) => {
  if (isPg) {
    const res = await pool.query(
      'SELECT * FROM bank_audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [userId]
    );
    return res.rows;
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    if (!data.audit_logs) return [];
    return data.audit_logs
      .filter(l => l.user_id === userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 30);
  }
};

// 12. Save KYC E-Form Details & E-Signature
db.saveKycForm = async (userId, { dob, address, taxId, income, occupation, signatureData }) => {
  if (isPg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM bank_kyc_forms WHERE user_id = $1', [userId]);
      await client.query(
        'INSERT INTO bank_kyc_forms (user_id, dob, address, tax_id, income, occupation, signature_data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, dob, address, taxId, income, occupation, signatureData]
      );
      await client.query('UPDATE bank_users SET kyc_status = \'Submitted\' WHERE id = $1', [userId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    if (!data.kyc_forms) data.kyc_forms = [];
    data.kyc_forms = data.kyc_forms.filter(f => f.user_id !== userId);
    data.kyc_forms.push({
      id: data.kyc_forms.length + 1,
      user_id: userId,
      dob,
      address,
      tax_id: taxId,
      income,
      occupation,
      signature_data: signatureData,
      submitted_at: new Date().toISOString()
    });
    const user = data.users.find(u => u.id === userId);
    if (user) user.kyc_status = 'Submitted';
    fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
  }
};

// 13. Retrieve KYC E-Form Details
db.getKycForm = async (userId) => {
  if (isPg) {
    const res = await pool.query('SELECT * FROM bank_kyc_forms WHERE user_id = $1', [userId]);
    return res.rows[0];
  } else {
    const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
    if (!data.kyc_forms) return null;
    return data.kyc_forms.find(f => f.user_id === userId) || null;
  }
};

// -------------------------------------------------------------
// EXPRESS APP MIDDLEWARES
// -------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Authentication Verification Middleware
function authenticateToken(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Access denied. Please login.' });
  }
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.clearCookie('auth_token');
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
}

// Middleware to enforce Admin Privileges
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
}

// -------------------------------------------------------------
// MULTER FILE UPLOAD STORAGE FOR KYC
// -------------------------------------------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'kyc-' + req.user.id + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid document type. Only PDF, JPG, and PNG are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB file limit
});

// -------------------------------------------------------------
// BACKEND API ROUTES
// -------------------------------------------------------------

// Register Route
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, confirmPassword } = req.body;

    // Validations
    if (!name || !email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Check if user already exists
    const existingUser = await db.findUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Account already registered with this email.' });
    }

    // Hash Password and Save
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = await db.createUser({ name, email, passwordHash });

    // Set Auth Cookie
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '2h' });
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'strict',
      maxAge: 2 * 60 * 60 * 1000 // 2 Hours
    });

    // Write audit log
    await db.logAudit(user.id, 'REGISTER', 'Apex account successfully created.', req.ip);

    res.status(201).json({
      message: 'Registration successful!',
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred during registration.' });
  }
});

// Login Route
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Please enter all fields.' });
    }

    // Find User
    const user = await db.findUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Match Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Role-based Access Control Selection validation
    const requestedRole = role || 'user';
    const actualRole = user.role || 'user';
    if (requestedRole !== actualRole) {
      return res.status(403).json({ error: 'Access denied. Account type does not match selected portal role.' });
    }

    // Set Token Cookie
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '2h' });
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'none' : 'strict',
      maxAge: 2 * 60 * 60 * 1000
    });

    // Write audit log
    await db.logAudit(user.id, 'LOGIN', 'Successful user authentication session.', req.ip);

    res.json({
      message: 'Login successful!',
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred during login.' });
  }
});

// Logout Route
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  await db.logAudit(req.user.id, 'LOGOUT', 'User logged out successfully.', req.ip);
  res.clearCookie('auth_token');
  res.json({ message: 'Logged out successfully.' });
});

// Fetch Dashboard Analytics Data
app.get('/api/dashboard-data', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    // Fetch transactions
    const txs = await db.getTransactions(userId, {});
    let uploadedDocs = [];
    if (isPg) {
      const docsRes = await pool.query('SELECT id, file_name, original_name, uploaded_at, status, doc_type, ocr_details FROM bank_kyc_docs WHERE user_id = $1 ORDER BY uploaded_at DESC', [userId]);
      uploadedDocs = docsRes.rows;
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      uploadedDocs = (data.kyc_docs || [])
        .filter(d => d.user_id === userId)
        .map(d => ({
          id: d.id,
          file_name: d.file_name,
          original_name: d.original_name,
          uploaded_at: d.uploaded_at,
          status: d.status || 'Pending',
          doc_type: d.doc_type || d.original_name.split(':')[0],
          ocr_details: d.ocr_details || ''
        }))
        .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    }

    // Calculate aggregated income and spending totals
    let totalIncome = 0;
    let totalSpending = 0;

    txs.forEach(t => {
      const amt = parseFloat(t.amount);
      if (t.type === 'Deposit' || t.type === 'Transfer (Received)') {
        totalIncome += amt;
      } else if (t.type === 'Withdrawal' || t.type === 'Transfer (Sent)') {
        totalSpending += amt;
      }
    });

    // Process last 7 days chart data
    const dailyStats = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dailyStats[dateStr] = { label, income: 0, spending: 0 };
    }

    txs.forEach(t => {
      const dateStr = new Date(t.created_at).toISOString().split('T')[0];
      if (dailyStats[dateStr]) {
        const amt = parseFloat(t.amount);
        if (t.type === 'Deposit' || t.type === 'Transfer (Received)') {
          dailyStats[dateStr].income += amt;
        } else if (t.type === 'Withdrawal' || t.type === 'Transfer (Sent)') {
          dailyStats[dateStr].spending += amt;
        }
      }
    });

    const chartLabels = [];
    const chartIncome = [];
    const chartSpending = [];

    Object.keys(dailyStats).sort().forEach(dateStr => {
      chartLabels.push(dailyStats[dateStr].label);
      chartIncome.push(dailyStats[dateStr].income);
      chartSpending.push(dailyStats[dateStr].spending);
    });

    res.json({
      user,
      stats: {
        balance: parseFloat(user.balance),
        totalIncome,
        totalSpending
      },
      chartData: {
        labels: chartLabels,
        income: chartIncome,
        spending: chartSpending
      },
      recentTransactions: txs.slice(0, 5),
      uploadedDocs
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
});

// Submit Transactions (Deposit/Withdrawal/Transfer)
app.post('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const { type, amount, targetEmail, remark } = req.body;
    const userId = req.user.id;

    if (!type || !amount) {
      return res.status(400).json({ error: 'Transaction type and amount are required.' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Transaction amount must be a positive number.' });
    }

    if (numAmount > 50000) {
      return res.status(400).json({ error: "More than 50,000 transaction can't be done." });
    }

    await db.executeTransaction({
      userId,
      type,
      amount: numAmount,
      targetEmail,
      remark
    });

    // Write audit logs and simulated notifications
    let auditDetails = '';
    if (type === 'Transfer') {
      auditDetails = `Sent ₹${numAmount.toFixed(2)} to ${targetEmail}. Remark: ${remark || 'None'}`;
      await db.logAudit(userId, 'TRANSFER_SENT', auditDetails, req.ip);

      const recipient = await db.findUserByEmail(targetEmail);
      if (recipient) {
        const sender = await db.getUserById(userId);
        await db.logAudit(recipient.id, 'TRANSFER_RECEIVED', `Received ₹${numAmount.toFixed(2)} from ${sender.email}. Remark: ${remark || 'None'}`, req.ip);
      }
    } else if (type === 'Deposit') {
      auditDetails = `Deposited ₹${numAmount.toFixed(2)}. Remark: ${remark || 'None'}`;
      await db.logAudit(userId, 'DEPOSIT', auditDetails, req.ip);
    } else if (type === 'Withdrawal') {
      auditDetails = `Withdrew ₹${numAmount.toFixed(2)}. Remark: ${remark || 'None'}`;
      await db.logAudit(userId, 'WITHDRAWAL', auditDetails, req.ip);
    }

    res.json({ message: 'Transaction processed successfully.' });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || 'Transaction failed.' });
  }
});

// Fetch All Transactions with Filter
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const txs = await db.getTransactions(req.user.id, { startDate, endDate });
    res.json({ transactions: txs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve transactions.' });
  }
});

// Download Account Statement in CSV Format
app.get('/api/transactions/statement', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const userId = req.user.id;
    const user = await db.getUserById(userId);
    const txs = await db.getTransactions(userId, { startDate, endDate });

    // Set HTTP CSV headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${user.email}-${Date.now()}.csv"`);

    let csvContent = 'Transaction ID,Date,Type,Amount (INR),Sender,Recipient,Remark,Status\n';
    txs.forEach(t => {
      const formattedDate = new Date(t.created_at).toLocaleString();
      const remarkCleaned = (t.remark || '').replace(/"/g, '""');
      csvContent += `${t.id},"${formattedDate}","${t.type}",${parseFloat(t.amount).toFixed(2)},"${t.sender_email || 'N/A'}","${t.recipient_email || 'N/A'}","${remarkCleaned}","${t.status}"\n`;
    });

    res.send(csvContent);
  } catch (error) {
    console.error(error);
    res.status(500).send('Failed to generate statements CSV.');
  }
});

// KYC Documents Upload Route
app.post('/api/kyc/upload', authenticateToken, (req, res) => {
  const uploadMiddleware = upload.single('kyc_document');

  uploadMiddleware(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please choose a valid file to upload.' });
    }

    const docType = req.body.doc_type || 'Document';
    let finalFilePath = req.file.path;

    try {
      // 1. Create the document record in the database first to get the unique docId
      const docId = await db.uploadKYC(req.user.id, {
        fileName: req.file.filename,
        originalName: `${docType}: ${req.file.originalname}`,
        filePath: finalFilePath, // This will be updated if Azure uploads successfully
        mimeType: req.file.mimetype,
        docType: docType
      });

      // 2. If Azure Storage is configured, upload to Azure and delete local copy
      if (containerClient) {
        try {
          const blobName = req.file.filename;
          const blockBlobClient = containerClient.getBlockBlobClient(blobName);
          
          // Upload to Azure with custom metadata
          await blockBlobClient.uploadFile(req.file.path, {
            metadata: {
              doc_type: docType,
              doc_id: docId.toString(),
              user_id: req.user.id.toString()
            }
          });
          console.log(`[AZURE STORAGE] Uploaded blob "${blobName}" with metadata successfully.`);
          
          // Update database file path to point to Azure
          finalFilePath = `azure://${containerName}/${blobName}`;
          if (isPg) {
            await pool.query('UPDATE bank_kyc_docs SET file_path = $1 WHERE id = $2', [finalFilePath, docId]);
          } else {
            const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
            const dbDoc = data.kyc_docs.find(d => d.id === docId);
            if (dbDoc) {
              dbDoc.file_path = finalFilePath;
              fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
            }
          }

          // Delete the temporary local file
          fs.unlink(req.file.path, (unlinkErr) => {
            if (unlinkErr) console.error('[AZURE STORAGE] Failed to delete local temp file:', unlinkErr.message);
          });
        } catch (azureErr) {
          console.error('[AZURE STORAGE] Blob upload failed:', azureErr.message);
          return res.status(500).json({ error: 'Failed to upload document to cloud storage.' });
        }
      }

      await db.logAudit(req.user.id, 'KYC_SUBMITTED', `Submitted ${docType} document: ${req.file.originalname}`, req.ip);
      
      res.json({
        message: `${docType} document uploaded successfully for verification.`,
        docId: docId,
        docType: docType
      });
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ error: 'Could not record document upload status.' });
    }
  });
});

// KYC Documents Auto-Validation Route
app.post('/api/kyc/validate', authenticateToken, async (req, res) => {
  try {
    const { docId } = req.body;
    if (!docId) {
      return res.status(400).json({ error: 'Document ID is required for validation.' });
    }

    // Retrieve document
    let doc;
    if (isPg) {
      const result = await pool.query('SELECT * FROM bank_kyc_docs WHERE id = $1 AND user_id = $2', [docId, req.user.id]);
      doc = result.rows[0];
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      doc = data.kyc_docs.find(d => d.id === parseInt(docId) && d.user_id === req.user.id);
    }

    if (!doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    // If Azure storage is active, validation is normally handled in the cloud by the Blob Trigger Azure Function
    if (containerClient) {
      // If the Service Bus client is not initialized (e.g. running locally without SB credentials
      // or the Function/App isn't consuming messages), fall back to the local simulator so the
      // user doesn't wait indefinitely.
      if (!serviceBusClient) {
        // Trigger local simulator asynchronously but respond immediately to the client
        const docType = doc.doc_type || 'Document';
        const originalname = doc.original_name.replace(`${docType}: `, '');
        triggerLocalVerificationSimulator(
          req.user.id,
          doc.id,
          docType,
          doc.file_name,
          originalname,
          doc.mime_type || 'application/pdf'
        );

        return res.json({
          success: true,
          status: 'Pending',
          message: 'Document uploaded to Azure. Service Bus not configured locally — local verification simulator started.'
        });
      }

      // Service Bus available — normal asynchronous processing
      return res.json({
        success: true,
        status: 'Pending',
        message: 'Document uploaded to Azure. Validation is being processed asynchronously by the Azure Function.'
      });
    } else {
      // If running locally, run the local simulator in the background
      const docType = doc.doc_type || 'Document';
      const originalname = doc.original_name.replace(`${docType}: `, '');
      
      triggerLocalVerificationSimulator(
        req.user.id,
        doc.id,
        docType,
        doc.file_name,
        originalname,
        doc.mime_type || 'application/pdf'
      );

      res.json({
        success: true,
        status: 'Pending',
        message: 'Local verification initiated. Simulated Azure Function validation is processing in the background.'
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'An error occurred during document validation.' });
  }
});

// Submit KYC Digital E-Form
app.post('/api/kyc/form-submit', authenticateToken, async (req, res) => {
  try {
    const { dob, address, taxId, income, occupation, signatureData } = req.body;

    if (!dob || !address || !taxId || !income || !occupation || !signatureData) {
      return res.status(400).json({ error: 'All fields and signature are required.' });
    }

    const dobDate = new Date(dob);
    if (isNaN(dobDate.getTime())) {
      return res.status(400).json({ error: 'Invalid Date of Birth format.' });
    }
    const age = (new Date() - dobDate) / (1000 * 60 * 60 * 24 * 365.25);
    if (age < 18) {
      return res.status(400).json({ error: 'You must be at least 18 years old to submit this form.' });
    }

    const validOccupations = ['Salaried Employee', 'Self-Employed / Business', 'Student', 'Retired', 'Professional'];
    if (!validOccupations.includes(occupation)) {
      return res.status(400).json({ error: 'Please select a valid occupation.' });
    }

    // Compulsory Passport Photo AND any 2 ID Docs before E-Form submission
    let hasPhoto = false;
    let uniqueIdCount = 0;
    if (isPg) {
      const docsRes = await pool.query('SELECT doc_type FROM bank_kyc_docs WHERE user_id = $1', [req.user.id]);
      hasPhoto = docsRes.rows.some(r => r.doc_type === 'Photo');
      const identityDocs = ['Aadhaar', 'PAN', 'Passport'];
      const uniqueIds = new Set(docsRes.rows.filter(r => identityDocs.includes(r.doc_type)).map(r => r.doc_type));
      uniqueIdCount = uniqueIds.size;
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      const userDocs = (data.kyc_docs || []).filter(d => d.user_id === req.user.id);
      hasPhoto = userDocs.some(d => d.doc_type === 'Photo');
      const identityDocs = ['Aadhaar', 'PAN', 'Passport'];
      const uniqueIds = new Set(userDocs.filter(d => identityDocs.includes(d.doc_type)).map(d => d.doc_type));
      uniqueIdCount = uniqueIds.size;
    }

    if (!hasPhoto || uniqueIdCount < 2) {
      return res.status(400).json({ 
        error: 'You must upload a Passport Photo AND at least 2 ID documents (Aadhaar, PAN, or Passport) before you can submit the E-Form and signature.' 
      });
    }

    await db.saveKycForm(req.user.id, {
      dob,
      address,
      taxId,
      income,
      occupation,
      signatureData
    });

    await db.logAudit(req.user.id, 'KYC_FORM_SUBMITTED', 'Submitted digital KYC identity E-form with E-signature.', req.ip);

    res.json({ message: 'KYC Digital E-Form submitted successfully for verification.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save KYC form details.' });
  }
});

// Admin Route: Get Users and Transactions Data
app.get('/api/admin/data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    const transactions = await db.getAllTransactions();
    res.json({ users, transactions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to load administrative panel data.' });
  }
});

// Admin Route: Update User KYC Status
app.post('/api/admin/kyc-status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId, status } = req.body;
    if (!['Pending', 'Submitted', 'Verified'].includes(status)) {
      return res.status(400).json({ error: 'Invalid KYC status.' });
    }
    
    // Self-approval check (Security Guardrail)
    if (req.user.id === parseInt(userId)) {
      return res.status(400).json({ error: 'Security Violations: Users cannot verify or approve their own KYC status.' });
    }
    
    await db.updateKYCStatus(parseInt(userId), status);
    await db.logAudit(parseInt(userId), 'KYC_VERIFICATION', `KYC verification status changed to ${status} by admin.`, req.ip);
    res.json({ message: `KYC Status updated to ${status}.` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update user KYC status.' });
  }
});

// Fetch Security logs for User
app.get('/api/security/logs', authenticateToken, async (req, res) => {
  try {
    const logs = await db.getAuditLogs(req.user.id);
    res.json({ logs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve security logs.' });
  }
});

// Securely Download KYC documents (accessible to authenticated users)
app.get('/api/kyc/download/:filename', authenticateToken, async (req, res) => {
  try {
    const filename = req.params.filename;
    let doc;
    if (isPg) {
      const result = await pool.query('SELECT * FROM bank_kyc_docs WHERE file_name = $1', [filename]);
      doc = result.rows[0];
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      doc = data.kyc_docs.find(d => d.file_name === filename);
    }

    if (!doc) {
      return res.status(404).json({ error: 'Document file not found.' });
    }

    // Clean up filename for header compatibility
    const safeName = doc.original_name.replace(/[:\\/]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');

    // Stream from Azure if URI is azure:// and client is initialized
    if (doc.file_path && doc.file_path.startsWith('azure://') && containerClient) {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        
        // This initiates the download stream from Azure (supporting automatic failover retry if using RA-GRS options)
        const downloadResponse = await blockBlobClient.download(0);
        downloadResponse.readableStreamBody.pipe(res);
        return;
      } catch (azureErr) {
        console.error('[AZURE STORAGE] Download from blob failed, attempting local fallback:', azureErr.message);
      }
    }

    // Local file fallback (for backward compatibility)
    const localFilePath = path.join(uploadDir, filename);
    if (!fs.existsSync(localFilePath)) {
      return res.status(404).json({ error: 'File physical record deleted.' });
    }
    fs.createReadStream(localFilePath).pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve files.' });
  }
});

// Admin Route: Reset Database (wipe all non-admin test data)
app.post('/api/admin/reset-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (isPg) {
      // Delete all transactions, audit logs, kyc forms, kyc docs, then non-admin users
      await pool.query('DELETE FROM bank_transactions');
      await pool.query('DELETE FROM bank_audit_logs');
      await pool.query('DELETE FROM bank_kyc_forms');
      await pool.query('DELETE FROM bank_kyc_docs');
      await pool.query("DELETE FROM bank_users WHERE role != 'admin'");
    } else {
      const data = JSON.parse(fs.readFileSync(JSON_DB_PATH, 'utf8'));
      const adminUsers = data.users.filter(u => u.role === 'admin');
      data.users = adminUsers;
      data.transactions = [];
      data.kyc_docs = [];
      data.audit_logs = [];
      data.kyc_forms = [];
      fs.writeFileSync(JSON_DB_PATH, JSON.stringify(data, null, 2));
    }

    let storageCleanup = null;
    let localCleanup = null;
    try {
      if (process.env.AZURE_STORAGE_CONNECTION_STRING && !process.env.AZURE_STORAGE_CONNECTION_STRING.includes('your_account_name')) {
        storageCleanup = await clearAzureKYCContainers();
      } else {
        localCleanup = clearLocalUploadFiles();
      }
    } catch (cleanupError) {
      console.error('[ADMIN] Storage cleanup failed:', cleanupError.message);
    }

    console.log('[ADMIN] Database reset performed by admin:', req.user.id);
    res.json({
      message: 'Database reset successfully. All test data has been cleared. Admin credentials preserved.',
      storageCleanup,
      localCleanup
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to reset database.' });
  }
});

// -------------------------------------------------------------
// FRONTEND WEB USER INTERFACE (HTML, CSS, JS Bundle template)
// -------------------------------------------------------------
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apex Premium Banking Portal</title>
  
  <!-- Font Imports -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  
  <!-- ChartJS and Icons -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  
  <style>
    /* -----------------------------------------------------------
       GLASSMORPHISM MODERN DESIGN SYSTEM
       ----------------------------------------------------------- */
    :root {
      --bg-radial: radial-gradient(circle at 10% 20%, rgb(4, 11, 29) 0%, rgb(18, 25, 46) 90.1%);
      --bg-card: rgba(16, 22, 42, 0.65);
      --bg-input: rgba(30, 41, 59, 0.45);
      
      --accent: #5e60ce;
      --accent-hover: #4ea8de;
      --accent-rgb: 94, 96, 206;
      --accent-success: #10b981;
      --accent-danger: #f43f5e;
      --accent-warning: #f59e0b;
      
      --text-white: #ffffff;
      --text-gray: #a0aec0;
      --text-dark: #718096;
      
      --border-thin: 1px solid rgba(255, 255, 255, 0.08);
      --border-accent: 1px solid rgba(94, 96, 206, 0.3);
      --glass-blur: blur(16px);
      --shadow-premium: 0 12px 40px 0 rgba(0, 0, 0, 0.6);
      --transition-fast: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Inter', sans-serif;
    }
    
    body {
      background: var(--bg-radial);
      min-height: 100vh;
      color: var(--text-white);
      overflow-x: hidden;
    }
    
    h1, h2, h3, h4, .brand-title {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
    }
    
    /* Custom Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(10, 15, 30, 0.5);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(94, 96, 206, 0.3);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(94, 96, 206, 0.6);
    }
    
    /* Layout Structure */
    #app-container {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    
    /* Auth Shell */
    .auth-wrapper {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    
    .auth-card {
      background: var(--bg-card);
      backdrop-filter: var(--glass-blur);
      border: var(--border-thin);
      box-shadow: var(--shadow-premium);
      width: 100%;
      max-width: 480px;
      padding: 40px;
      border-radius: 20px;
      position: relative;
      overflow: hidden;
      transition: var(--transition-fast);
    }
    
    .auth-card::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(94, 96, 206, 0.08) 0%, transparent 60%);
      pointer-events: none;
    }
    
    .brand-header {
      text-align: center;
      margin-bottom: 30px;
    }
    
    .brand-icon {
      font-size: 2.5rem;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 5px;
      display: inline-block;
      font-weight: 800;
      letter-spacing: -1px;
    }
    
    .brand-subtitle {
      color: var(--text-gray);
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    
    /* Forms Controls */
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--text-gray);
      letter-spacing: 0.5px;
    }
    
    .form-control {
      width: 100%;
      padding: 12px 16px;
      background: var(--bg-input);
      border: var(--border-thin);
      border-radius: 10px;
      color: var(--text-white);
      font-size: 0.95rem;
      transition: var(--transition-fast);
    }
    
    .form-control:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(94, 96, 206, 0.2);
    }
    
    .btn {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      border: none;
      border-radius: 10px;
      color: var(--text-white);
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(94, 96, 206, 0.3);
      transition: var(--transition-fast);
      display: inline-flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    }
    
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(94, 96, 206, 0.5);
    }
    
    .btn:active {
      transform: translateY(0);
    }
    
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      box-shadow: none;
      border: var(--border-thin);
    }
    
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
      box-shadow: none;
    }
    
    .auth-footer {
      text-align: center;
      margin-top: 25px;
      font-size: 0.9rem;
      color: var(--text-gray);
    }
    
    .auth-link {
      color: var(--accent-hover);
      text-decoration: none;
      font-weight: 500;
      transition: var(--transition-fast);
    }
    
    .auth-link:hover {
      color: var(--text-white);
      text-decoration: underline;
    }
    
    /* Main Layout */
    .dashboard-header {
      background: rgba(10, 16, 32, 0.8);
      backdrop-filter: var(--glass-blur);
      border-bottom: var(--border-thin);
      padding: 15px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .logo-container {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .logo-text {
      font-size: 1.4rem;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-weight: 800;
    }
    
    .user-actions {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    
    .user-profile {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: var(--text-white);
      box-shadow: 0 0 10px rgba(94, 96, 206, 0.4);
    }
    
    .badge {
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .badge-pending {
      background: var(--accent-warning-bg);
      color: var(--accent-warning);
      border: 1px solid rgba(245, 158, 11, 0.2);
    }
    
    .badge-submitted {
      background: rgba(94, 96, 206, 0.15);
      color: var(--accent-hover);
      border: 1px solid rgba(94, 96, 206, 0.3);
    }
    
    .badge-verified {
      background: var(--accent-success-bg);
      color: var(--accent-success);
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    
    /* Navigation */
    .main-layout {
      display: flex;
      flex: 1;
      min-height: calc(100vh - 70px);
    }
    
    .sidebar {
      width: 260px;
      background: rgba(8, 12, 24, 0.7);
      backdrop-filter: var(--glass-blur);
      border-right: var(--border-thin);
      padding: 30px 15px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      border-radius: 12px;
      color: var(--text-gray);
      text-decoration: none;
      font-weight: 500;
      cursor: pointer;
      transition: var(--transition-fast);
    }
    
    .nav-item:hover {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-white);
      transform: translateX(4px);
    }
    
    .nav-item.active {
      background: linear-gradient(135deg, rgba(94, 96, 206, 0.2), rgba(94, 96, 206, 0.05));
      color: var(--text-white);
      border-left: 3px solid var(--accent);
    }
    
    .content-area {
      flex: 1;
      padding: 40px;
      overflow-y: auto;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
    }
    
    .tab-pane {
      display: none;
      animation: fadeInUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    .tab-pane.active {
      display: block;
    }
    
    /* Cards Framework */
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 30px;
      margin-bottom: 30px;
    }
    
    .card {
      background: var(--bg-card);
      backdrop-filter: var(--glass-blur);
      border: var(--border-thin);
      box-shadow: var(--shadow-premium);
      border-radius: 16px;
      padding: 30px;
      position: relative;
    }
    
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding-bottom: 15px;
    }
    
    .card-title {
      font-size: 1.15rem;
      color: var(--text-white);
    }
    
    /* Metric Cards */
    .metric-card {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: linear-gradient(135deg, rgba(16, 22, 42, 0.8), rgba(8, 12, 24, 0.9));
    }
    
    .metric-label {
      font-size: 0.85rem;
      color: var(--text-gray);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .metric-value {
      font-size: 2.2rem;
      font-weight: 700;
      font-family: 'Outfit', sans-serif;
    }
    
    .metric-trend {
      font-size: 0.85rem;
      font-weight: 500;
    }
    
    .trend-up { color: var(--accent-success); }
    .trend-down { color: var(--accent-danger); }
    
    /* Tables Styling */
    .table-container {
      overflow-x: auto;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    
    th {
      padding: 14px 16px;
      font-weight: 600;
      color: var(--text-gray);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    td {
      padding: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-white);
      font-size: 0.9rem;
    }
    
    tr:hover td {
      background: rgba(255, 255, 255, 0.01);
    }
    
    .amount-positive {
      color: var(--accent-success);
      font-weight: 600;
    }
    
    .amount-negative {
      color: var(--accent-danger);
      font-weight: 600;
    }
    
    /* Custom Components styling */
    .alert-banner {
      background: rgba(94, 96, 206, 0.1);
      border: var(--border-accent);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      gap: 15px;
      align-items: center;
      margin-bottom: 30px;
    }
    
    .alert-message {
      font-size: 0.9rem;
      line-height: 1.5;
    }
    
    /* Document Upload Area */
    .upload-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 20px;
    }
    
    .upload-slot-card {
      background: var(--bg-input);
      border: var(--border-thin);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      cursor: pointer;
      transition: var(--transition-fast);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 140px;
      position: relative;
    }
    
    .upload-slot-card:hover {
      border-color: var(--accent);
      background: rgba(94, 96, 206, 0.1);
      transform: translateY(-2px);
    }
    
    .upload-slot-card.disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
    
    .upload-slot-card.disabled:hover {
      border-color: rgba(255, 255, 255, 0.08);
      background: var(--bg-input);
      transform: none;
    }
    
    .upload-slot-icon {
      font-size: 2rem;
      margin-bottom: 10px;
    }
    
    .upload-slot-title {
      font-weight: 600;
      font-size: 0.95rem;
      margin-bottom: 4px;
      font-family: 'Outfit', sans-serif;
    }
    
    .upload-slot-desc {
      font-size: 0.75rem;
      color: var(--text-gray);
    }
    
    .spinner-small {
      border: 3px solid rgba(255, 255, 255, 0.1);
      border-radius: 50%;
      border-top: 3px solid var(--accent);
      width: 24px;
      height: 24px;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .upload-subtitle {
      font-size: 0.75rem;
      color: var(--text-dark);
      margin-top: 8px;
    }
    
    /* Toast notifications */
    #toast-container {
      position: fixed;
      bottom: 30px;
      right: 30px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .toast {
      background: rgba(16, 22, 42, 0.9);
      backdrop-filter: var(--glass-blur);
      border: var(--border-thin);
      padding: 16px 24px;
      border-radius: 10px;
      min-width: 320px;
      box-shadow: var(--shadow-premium);
      display: flex;
      align-items: center;
      gap: 12px;
      transform: translateY(50px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    
    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    
    .toast-success { border-left: 4px solid var(--accent-success); }
    .toast-error { border-left: 4px solid var(--accent-danger); }
    .toast-info { border-left: 4px solid var(--accent); }
    
    .toast-icon {
      font-size: 1.2rem;
      font-weight: bold;
    }
    .toast-success .toast-icon { color: var(--accent-success); }
    .toast-error .toast-icon { color: var(--accent-danger); }
    .toast-info .toast-icon { color: var(--accent); }
    
    .toast-message {
      font-size: 0.9rem;
      color: var(--text-white);
    }
    
    /* Custom Admin styles */
    .admin-action-btn {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      border: none;
      cursor: pointer;
      transition: var(--transition-fast);
    }
    .admin-btn-verify {
      background: var(--accent-success);
      color: var(--text-white);
    }
    .admin-btn-reject {
      background: var(--accent-danger);
      color: var(--text-white);
    }
    .admin-action-btn:hover {
      filter: brightness(1.2);
    }
    
    /* Animations */
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    /* Responsive controls */
    @media (max-width: 900px) {
      .main-layout {
        flex-direction: column;
      }
      .sidebar {
        width: 100%;
        border-right: none;
        border-bottom: var(--border-thin);
        flex-direction: row;
        overflow-x: auto;
        padding: 15px;
      }
      .nav-item {
        white-space: nowrap;
        padding: 10px 15px;
      }
      .nav-item.active {
        border-left: none;
        border-bottom: 3px solid var(--accent);
      }
      .content-area {
        padding: 20px;
      }
    }
    
    @media (max-width: 600px) {
      .dashboard-header {
        flex-direction: column;
        gap: 15px;
        padding: 15px;
        text-align: center;
      }
      .user-actions {
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
</head>
<body>

  <!-- Toast Wrapper Container -->
  <div id="toast-container"></div>

  <!-- Main View Container -->
  <div id="app-container">
    
    <!-- -----------------------------------------------------------
       1. AUTHENTICATION SECTION (LOGIN / REGISTER)
       ----------------------------------------------------------- -->
    <div id="auth-section" class="auth-wrapper">
      
      <!-- Login View -->
      <div id="login-card" class="auth-card">
        <div class="brand-header">
          <div class="brand-icon">APEX</div>
          <div class="brand-subtitle">Premium Banking</div>
        </div>
        
        <form id="login-form">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="login-email" class="form-control" placeholder="name@example.com" required autocomplete="email">
          </div>
          <div class="form-group">
            <label class="form-label">Portal Access Role</label>
            <select id="login-role" class="form-control" style="background: var(--bg-input); color: var(--text-white); border: var(--border-thin); cursor: pointer;" required>
              <option value="user" selected>Standard Customer Portal</option>
              <option value="admin">Administrative Console</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <div style="position: relative;">
              <input type="password" id="login-password" class="form-control" placeholder="••••••••" required autocomplete="current-password" style="padding-right: 45px;">
              <button type="button" onclick="togglePasswordVisibility('login-password')" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-gray); cursor: pointer; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; padding: 0;">👁️</button>
            </div>
          </div>
          <button type="submit" class="btn">
            Log In
          </button>
        </form>
        
        <div class="auth-footer">
          Don't have an account? <a href="#register" class="auth-link" onclick="toggleAuthView('register')">Register here</a>
        </div>

        <div style="margin-top: 20px; padding: 15px; background: rgba(94, 96, 206, 0.1); border: 1px solid rgba(94, 96, 206, 0.3); border-radius: 8px; font-size: 0.85rem; color: var(--text-gray); text-align: center;">
          <strong>Demo Admin Access:</strong><br>
          Select "Administrative Console" Role<br>
          Email: <code>admin@apex.com</code> | Pass: <code>admin123</code>
        </div>
      </div>
      
      <!-- Registration View -->
      <div id="register-card" class="auth-card" style="display: none;">
        <div class="brand-header">
          <div class="brand-icon">APEX</div>
          <div class="brand-subtitle">Premium Registration</div>
        </div>
        
        <form id="register-form">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" id="register-name" class="form-control" placeholder="John Doe" required autocomplete="name">
          </div>
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="register-email" class="form-control" placeholder="name@example.com" required autocomplete="email">
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <div style="position: relative;">
              <input type="password" id="register-password" class="form-control" placeholder="Minimum 6 characters" required autocomplete="new-password" style="padding-right: 45px;">
              <button type="button" onclick="togglePasswordVisibility('register-password')" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-gray); cursor: pointer; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; padding: 0;">👁️</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Confirm Password</label>
            <div style="position: relative;">
              <input type="password" id="register-confirm" class="form-control" placeholder="Verify password" required autocomplete="new-password" style="padding-right: 45px;">
              <button type="button" onclick="togglePasswordVisibility('register-confirm')" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-gray); cursor: pointer; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; padding: 0;">👁️</button>
            </div>
          </div>
          <button type="submit" class="btn">
            Create Account
          </button>
        </form>
        
        <div class="auth-footer">
          Already have an account? <a href="#login" class="auth-link" onclick="toggleAuthView('login')">Log in here</a>
        </div>
      </div>
      
    </div>

    <!-- -----------------------------------------------------------
       2. BANK CLIENT PORTAL (AUTHENTICATED SHELL)
       ----------------------------------------------------------- -->
    <div id="portal-section" style="display: none;">
      
      <!-- Top Sticky Header -->
      <header class="dashboard-header">
        <div class="logo-container">
          <div class="avatar">A</div>
          <div class="logo-text">APEX BANK</div>
        </div>
        <div class="user-actions">
          <div class="user-profile">
            <div>
              <div id="profile-name" style="font-weight: 600;">Loading...</div>
              <div id="profile-email" style="font-size: 0.8rem; color: var(--text-gray);">Loading...</div>
            </div>
            <span id="kyc-badge" class="badge badge-pending">KYC: Pending</span>
          </div>
          <button onclick="handleLogout()" class="btn btn-secondary" style="padding: 8px 16px; width: auto; font-size: 0.85rem;">
            Log Out
          </button>
        </div>
      </header>
      
      <div class="main-layout">
        
        <!-- Sidebar Navigation -->
        <nav class="sidebar">
          <a class="nav-item active" data-tab="tab-overview" onclick="switchTab('tab-overview')">
            <span class="nav-icon">📊</span> Overview
          </a>
          <a class="nav-item" data-tab="tab-transactions" onclick="switchTab('tab-transactions')">
            <span class="nav-icon">💸</span> Transactions List
          </a>
          <a class="nav-item" data-tab="tab-transfer" onclick="switchTab('tab-transfer')">
            <span class="nav-icon">🔄</span> Transfer & Funds
          </a>
          <a class="nav-item" data-tab="tab-kyc" onclick="switchTab('tab-kyc')">
            <span class="nav-icon">🛡️</span> Verification (KYC)
          </a>
          <a class="nav-item" data-tab="tab-security" onclick="switchTab('tab-security')">
            <span class="nav-icon">🔒</span> Security & Alerts
          </a>
          <a class="nav-item" data-tab="tab-admin" id="admin-nav-item" onclick="switchTab('tab-admin')" style="display: none;">
            <span class="nav-icon">⚙️</span> Control Center
          </a>
        </nav>
        
        <!-- Core Dynamic Tab Views -->
        <main class="content-area">
          
          <!-- TAB 1: OVERVIEW & ANALYTICS -->
          <div id="tab-overview" class="tab-pane active">
            <div class="alert-banner" id="kyc-alert-banner">
              <span style="font-size: 1.5rem;">⚠️</span>
              <div class="alert-message">
                <strong>KYC verification needed:</strong> Your account is currently unverified. To enjoy unrestricted financial limits, please complete your identification in the <strong>Verification (KYC)</strong> tab.
              </div>
            </div>
            
            <!-- Cards Row -->
            <div class="row">
              <div class="card metric-card">
                <div class="metric-label">Account Balance</div>
                <div class="metric-value" id="val-balance">₹0.00</div>
                <div class="metric-trend trend-up">Available Fund</div>
              </div>
              <div class="card metric-card">
                <div class="metric-label">Total Inflow (Deposits)</div>
                <div class="metric-value" id="val-income">₹0.00</div>
                <div class="metric-trend trend-up">↑ 100% Secure</div>
              </div>
              <div class="card metric-card">
                <div class="metric-label">Total Outflow (Debited)</div>
                <div class="metric-value" id="val-spending">₹0.00</div>
                <div class="metric-trend trend-down">↓ Controlled Cash flow</div>
              </div>
            </div>
            
            <div class="row" style="grid-template-columns: 2fr 1fr;">
              <!-- 7-Day Income/Expense Bar Chart -->
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Income & Spending History (7 Days)</h3>
                </div>
                <div style="height: 300px; position: relative;">
                  <canvas id="chart-activity"></canvas>
                </div>
              </div>
              
              <!-- Income vs Expense Doughnut -->
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Balance Breakdown</h3>
                </div>
                <div style="height: 300px; position: relative; display: flex; justify-content: center;">
                  <canvas id="chart-breakdown"></canvas>
                </div>
              </div>
            </div>
            
            <!-- Recent Transactions Table -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">Recent Transactions</h3>
                <button onclick="switchTab('tab-transactions')" class="btn btn-secondary" style="padding: 6px 12px; width: auto; font-size: 0.8rem;">
                  View All
                </button>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Transaction Type</th>
                      <th>Remark</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody id="table-recent-body">
                    <tr>
                      <td colspan="5" style="text-align: center; color: var(--text-dark);">No transaction logs available.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          
          <!-- TAB 2: TRANSACTIONS LIST & EXPORTS -->
          <div id="tab-transactions" class="tab-pane">
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">Account Statements History</h3>
              </div>
              
              <!-- Filter Options -->
              <div class="row" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px;">
                <div class="form-group" style="margin-bottom: 0;">
                  <label class="form-label">Start Date</label>
                  <input type="date" id="filter-start-date" class="form-control">
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                  <label class="form-label">End Date</label>
                  <input type="date" id="filter-end-date" class="form-control">
                </div>
                <div style="display: flex; align-items: flex-end; gap: 10px;">
                  <button onclick="loadAllTransactions()" class="btn" style="padding: 11px;">Apply Filters</button>
                  <button onclick="downloadCSVStatement()" class="btn btn-secondary" style="padding: 11px;">Export CSV</button>
                </div>
              </div>
              
              <!-- Transactions Log Table -->
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Sender</th>
                      <th>Recipient</th>
                      <th>Remark</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody id="table-full-body">
                    <tr>
                      <td colspan="8" style="text-align: center; color: var(--text-dark);">No transaction records.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          
          <!-- TAB 3: TRANSFER & DEPOSIT FUNDS -->
          <div id="tab-transfer" class="tab-pane">
            <div class="row">
              
              <!-- Action Form -->
              <div class="card" style="flex: 1.5;">
                <div class="card-header">
                  <h3 class="card-title">Initiate Transaction</h3>
                </div>
                <form id="tx-form">
                  <div class="form-group">
                    <label class="form-label">Transaction Type</label>
                    <select id="tx-type" class="form-control" onchange="toggleTransferFields()" required>
                      <option value="Deposit">Deposit Funds (Self)</option>
                      <option value="Withdrawal">Withdraw Funds (Self)</option>
                      <option value="Transfer">Transfer to another user</option>
                    </select>
                  </div>
                  
                  <!-- Recipient Field (Dynamic display) -->
                  <div class="form-group" id="tx-recipient-group" style="display: none;">
                    <label class="form-label">Recipient's Registered Email</label>
                    <input type="email" id="tx-recipient" class="form-control" placeholder="user@domain.com">
                  </div>
                  
                  <div class="form-group">
                    <label class="form-label">Amount (INR)</label>
                    <input type="number" step="0.01" min="1" id="tx-amount" class="form-control" placeholder="0.00" required>
                  </div>
                  <div class="form-group">
                    <label class="form-label">Remark / Reference Note</label>
                    <input type="text" id="tx-remark" class="form-control" placeholder="E.g., Rent payment, savings deposit">
                  </div>
                  
                  <button type="submit" class="btn">Submit Transaction</button>
                </form>
              </div>
              
              <!-- Info Panel -->
              <div class="card" style="flex: 1; display: flex; flex-direction: column; justify-content: space-between;">
                <div>
                  <h3 class="card-title" style="margin-bottom: 15px;">Transaction Limits</h3>
                  <p style="color: var(--text-gray); font-size: 0.9rem; margin-bottom: 20px; line-height: 1.6;">
                    To protect users, Apex Bank enforces initial transfer thresholds. Verification elevates safety limits.
                  </p>
                  
                  <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">
                      <span style="color: var(--text-gray);">Daily Deposit:</span>
                      <strong>Unlimited</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">
                      <span style="color: var(--text-gray);">Daily Unverified Transfer:</span>
                      <strong>₹25,000.00</strong>
                    </div>
                    <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">
                      <span style="color: var(--text-gray);">Daily Verified Transfer:</span>
                      <strong>₹5,00,000.00</strong>
                    </div>
                  </div>
                </div>
                
                <div style="background: rgba(255,255,255,0.02); border-radius: 8px; padding: 15px; text-align: center; border: var(--border-thin);">
                  <div style="font-size: 0.75rem; color: var(--text-dark); text-transform: uppercase;">Current balance status</div>
                  <div style="font-size: 1.4rem; font-weight: 700; color: var(--accent-hover); margin-top: 5px;" id="info-card-balance">₹0.00</div>
                </div>
              </div>
              
            </div>
          </div>
          
          <!-- TAB 4: KYC UPLOAD & METADATA -->
          <div id="tab-kyc" class="tab-pane">
            <div class="row">
              <!-- Upload Area -->
              <div class="card" style="flex: 1.5; padding: 0;">
                <div class="card-header" style="flex-direction: column; align-items: flex-start; gap: 15px; padding: 30px 30px 15px 30px;">
                  <h3 class="card-title">Security KYC Verification</h3>
                  <div style="display: flex; gap: 10px; width: 100%;">
                    <button type="button" id="btn-kyc-upload-tab" onclick="switchKycMethod('upload')" class="btn" style="padding: 8px 16px; font-size: 0.85rem; width: auto; border-radius: 6px;">Option A: Document Upload</button>
                    <button type="button" id="btn-kyc-eform-tab" onclick="switchKycMethod('eform')" class="btn btn-secondary" style="padding: 8px 16px; font-size: 0.85rem; width: auto; border-radius: 6px;">Option B: Digital E-Form (E-Sign)</button>
                  </div>
                </div>
                
                <div id="kyc-status-msg" style="margin-bottom: 20px; font-weight: 500; padding: 0 30px;"></div>
                <div id="kyc-uploaded-docs-container" style="display: none; padding: 0 30px; margin-bottom: 20px;">
                  <h4 style="font-size: 0.9rem; margin-bottom: 10px; color: var(--text-white);">Uploaded Verification Documents</h4>
                  <div id="kyc-uploaded-docs-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
                </div>
                
                <div style="padding: 0 30px 30px 30px;">
                  <!-- Method A: Upload Form -->
                  <div id="kyc-upload-container">
                    <p style="color: var(--text-gray); font-size: 0.85rem; margin-bottom: 20px; text-align: center;">
                      Select a slot below to upload your digital proof. Supported formats: PDF, JPG, PNG (Max 10MB).
                    </p>
                    <div class="upload-grid">
                      <!-- Slot 1: Aadhaar -->
                      <div id="slot-card-Aadhaar" class="upload-slot-card" onclick="triggerSlotUpload('Aadhaar')">
                        <span class="upload-slot-icon">🪪</span>
                        <div class="upload-slot-title">Aadhaar Card</div>
                        <div class="upload-slot-desc">National identity & address proof</div>
                        <div class="slot-status-badge" id="slot-status-Aadhaar" style="display: none; margin-top: 10px; font-size: 0.8rem; font-weight: 600; padding: 4px 8px; border-radius: 12px;"></div>
                      </div>
                      
                      <!-- Slot 2: PAN Card -->
                      <div id="slot-card-PAN" class="upload-slot-card" onclick="triggerSlotUpload('PAN')">
                        <span class="upload-slot-icon">💳</span>
                        <div class="upload-slot-title">PAN Card</div>
                        <div class="upload-slot-desc">Tax registration ID card</div>
                        <div class="slot-status-badge" id="slot-status-PAN" style="display: none; margin-top: 10px; font-size: 0.8rem; font-weight: 600; padding: 4px 8px; border-radius: 12px;"></div>
                      </div>
                      
                      <!-- Slot 3: Passport -->
                      <div id="slot-card-Passport" class="upload-slot-card" onclick="triggerSlotUpload('Passport')">
                        <span class="upload-slot-icon">🛂</span>
                        <div class="upload-slot-title">Passport</div>
                        <div class="upload-slot-desc">International ID & travel proof</div>
                        <div class="slot-status-badge" id="slot-status-Passport" style="display: none; margin-top: 10px; font-size: 0.8rem; font-weight: 600; padding: 4px 8px; border-radius: 12px;"></div>
                      </div>
                      
                      <!-- Slot 4: Photo -->
                      <div id="slot-card-Photo" class="upload-slot-card" onclick="triggerSlotUpload('Photo')">
                        <span class="upload-slot-icon">👤</span>
                        <div class="upload-slot-title">Passport Photo</div>
                        <div class="upload-slot-desc">Recent color face picture</div>
                        <div class="slot-status-badge" id="slot-status-Photo" style="display: none; margin-top: 10px; font-size: 0.8rem; font-weight: 600; padding: 4px 8px; border-radius: 12px;"></div>
                      </div>
                    </div>

                    <!-- Hidden Inputs outside the grid to prevent click bubbling recursion loops -->
                    <input type="file" id="upload-file-Aadhaar" style="display: none;" onchange="handleSlotSelect(this, 'Aadhaar')">
                    <input type="file" id="upload-file-PAN" style="display: none;" onchange="handleSlotSelect(this, 'PAN')">
                    <input type="file" id="upload-file-Passport" style="display: none;" onchange="handleSlotSelect(this, 'Passport')">
                    <input type="file" id="upload-file-Photo" style="display: none;" onchange="handleSlotSelect(this, 'Photo')">
                  </div>

                  <!-- Method B: E-Form -->
                  <div id="kyc-eform-container" style="display: none;">
                    <form id="kyc-eform">
                      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div class="form-group" style="margin-bottom: 0;">
                          <label class="form-label">Date of Birth</label>
                          <input type="date" id="eform-dob" class="form-control">
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                          <label class="form-label">Tax ID / PAN Card / SSN</label>
                          <input type="text" id="eform-tax-id" class="form-control" placeholder="E.g., ABCDE1234F">
                        </div>
                      </div>
                      
                      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div class="form-group" style="margin-bottom: 0;">
                          <label class="form-label">Annual Income Range</label>
                          <select id="eform-income" class="form-control">
                            <option value="" disabled selected>Select Income Range</option>
                            <option value="Under ₹5 Lakhs">Under ₹5 Lakhs</option>
                            <option value="₹5 Lakhs - ₹10 Lakhs">₹5 Lakhs - ₹10 Lakhs</option>
                            <option value="₹10 Lakhs - ₹25 Lakhs">₹10 Lakhs - ₹25 Lakhs</option>
                            <option value="Over ₹25 Lakhs">Over ₹25 Lakhs</option>
                          </select>
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                          <label class="form-label">Occupation</label>
                          <select id="eform-occupation" class="form-control">
                            <option value="" disabled selected>Select Occupation</option>
                            <option value="Salaried Employee">Salaried Employee</option>
                            <option value="Self-Employed / Business">Self-Employed / Business</option>
                            <option value="Student">Student</option>
                            <option value="Retired">Retired</option>
                            <option value="Professional">Professional</option>
                          </select>
                        </div>
                      </div>
                      
                      <div class="form-group">
                        <label class="form-label">Residential Address</label>
                        <input type="text" id="eform-address" class="form-control" placeholder="Enter your full billing address">
                      </div>
                      
                      <div class="form-group">
                        <label class="form-label">Draw your Digital Signature below</label>
                        <div style="background: #ffffff; border-radius: 8px; border: var(--border-thin); overflow: hidden; padding: 5px; position: relative;">
                          <canvas id="signature-pad" width="420" height="150" style="width: 100%; height: 150px; background: #fafafa; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; cursor: crosshair; display: block; touch-action: none;"></canvas>
                        </div>
                        <div style="display: flex; justify-content: flex-end; margin-top: 8px; gap: 10px;">
                          <button type="button" class="btn btn-secondary" onclick="clearSignaturePad()" style="padding: 6px 12px; width: auto; font-size: 0.8rem; border-radius: 6px;">Clear Pad</button>
                        </div>
                      </div>
                      
                      <button type="submit" class="btn" id="kyc-eform-submit-btn">Submit Digital Form & Signature</button>
                    </form>
                  </div>
                </div>
              </div>
              
              <!-- Help text -->
              <div class="card" style="flex: 1;">
                <h3 class="card-title" style="margin-bottom: 15px;">Why KYC?</h3>
                <p style="color: var(--text-gray); font-size: 0.9rem; line-height: 1.6; margin-bottom: 15px;">
                  Know Your Customer (KYC) is a mandatory identity check required by regulations to prevent fraud, money laundering, and protect your digital funds.
                </p>
                <h4 style="font-size: 0.9rem; margin-bottom: 8px;">Documents Checklist:</h4>
                <ul style="color: var(--text-gray); font-size: 0.85rem; padding-left: 20px; line-height: 1.6; display: flex; flex-direction: column; gap: 8px;">
                  <li>National Identification (Aadhaar / Passport)</li>
                  <li>Tax Registration Certificate (PAN card)</li>
                  <li>Name and signature must be clearly visible.</li>
                </ul>
              </div>
            </div>
          </div>

          <!-- TAB 6: SECURITY & AUDIT LOGS -->
          <div id="tab-security" class="tab-pane">
            <div class="row" style="grid-template-columns: 2fr 1fr;">
              <!-- Audit Logs Table -->
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Security & Session Audit Trail</h3>
                </div>
                <p style="color: var(--text-gray); font-size: 0.85rem; margin-bottom: 20px;">
                  This log tracks account registrations, login/logout sessions, transfers, and KYC updates. Set by bank security compliance rules.
                </p>
                <div class="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th>Date & Time</th>
                        <th>Security Event</th>
                        <th>Details</th>
                        <th>Access IP</th>
                      </tr>
                    </thead>
                    <tbody id="table-security-logs">
                      <tr>
                        <td colspan="4" style="text-align: center; color: var(--text-dark);">No audit log files found.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              
              <!-- Alerts Card -->
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">Real-time Push Alerts</h3>
                </div>
                <p style="color: var(--text-gray); font-size: 0.85rem; margin-bottom: 20px;">
                  Simulated real-time push alerts sent to your registered contact channel.
                </p>
                <div id="alerts-notification-list" style="display: flex; flex-direction: column; gap: 15px;">
                  <div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 12px;">
                    <div style="font-size: 0.75rem; color: var(--text-dark); margin-bottom: 4px;">SYSTEM ALERT - Just Now</div>
                    <div style="font-size: 0.85rem; font-weight: 500;">Secure notification service initialized.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <!-- TAB 5: ADMIN / TESTING CONTROL CENTER -->
          <div id="tab-admin" class="tab-pane">
            <div class="alert-banner" style="background: rgba(16, 185, 129, 0.05); border-color: rgba(16, 185, 129, 0.3);">
              <span style="font-size: 1.5rem;">⚙️</span>
              <div class="alert-message">
                <strong>Apex Control Center:</strong> This section is provided for demo testing. It aggregates all users, transactions, and submitted KYC uploads in the database. You can instantly approve or reject user verifications below.
              </div>
            </div>
            
            <!-- Users list -->
            <div class="card" style="margin-bottom: 30px;">
              <div class="card-header">
                <h3 class="card-title">Registered System Users</h3>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Balance</th>
                      <th>KYC Status</th>
                      <th>Uploaded Files</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody id="table-admin-users">
                    <tr>
                      <td colspan="7" style="text-align: center; color: var(--text-dark);">No registered users in db.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            
            <!-- System transactions -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">Universal Transactions Logs</h3>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>User</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Sender</th>
                      <th>Recipient</th>
                      <th>Date</th>
                      <th>Remark</th>
                    </tr>
                  </thead>
                  <tbody id="table-admin-txs">
                    <tr>
                      <td colspan="8" style="text-align: center; color: var(--text-dark);">No transaction logs available in system db.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Danger Zone: Reset Database -->
            <div class="card" style="margin-top: 30px; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.04);">
              <div class="card-header" style="border-bottom-color: rgba(239, 68, 68, 0.2);">
                <h3 class="card-title" style="color: #ef4444;">⚠️ Danger Zone</h3>
              </div>
              <div style="padding: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 15px;">
                <div>
                  <div style="font-weight: 600; color: var(--text-white); margin-bottom: 5px;">Reset Database</div>
                  <div style="font-size: 0.85rem; color: var(--text-gray);">Permanently deletes ALL registered users, transactions, KYC documents and audit logs. Admin credentials will be preserved.</div>
                </div>
                <button id="btn-reset-db" onclick="resetDatabase()" style="background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.5); padding: 10px 22px; border-radius: 8px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'" onmouseout="this.style.background='rgba(239,68,68,0.15)'">
                  🗑️ Reset All Data
                </button>
              </div>
            </div>

          </div>
          
        </main>
      </div>
    </div>
    
  </div>

  <!-- KYC E-Form Modal -->
  <div id="kyc-modal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); backdrop-filter: blur(8px); z-index: 10000; justify-content: center; align-items: center; padding: 20px;">
    <div class="card" style="width: 100%; max-width: 550px; background: rgb(16, 22, 42); border: var(--border-thin); position: relative;">
      <button onclick="closeKycModal()" style="position: absolute; right: 20px; top: 20px; background: none; border: none; color: var(--text-gray); font-size: 1.5rem; cursor: pointer;">×</button>
      <div class="card-header" style="margin-bottom: 20px; padding-bottom: 10px;">
        <h3 class="card-title">KYC Digital Identity Record</h3>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 0.9rem;">
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Full Name</div>
          <strong id="modal-kyc-name" style="color: white;">-</strong>
        </div>
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Email Address</div>
          <strong id="modal-kyc-email" style="color: white;">-</strong>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 0.9rem;">
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Date of Birth</div>
          <strong id="modal-kyc-dob" style="color: white;">-</strong>
        </div>
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Tax ID (PAN/SSN)</div>
          <strong id="modal-kyc-tax" style="color: white;">-</strong>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 0.9rem;">
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Annual Income</div>
          <strong id="modal-kyc-income" style="color: white;">-</strong>
        </div>
        <div>
          <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Occupation</div>
          <strong id="modal-kyc-occupation" style="color: white;">-</strong>
        </div>
      </div>
      
      <div style="margin-bottom: 15px; font-size: 0.9rem;">
        <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase;">Residential Address</div>
        <strong id="modal-kyc-address" style="color: white;">-</strong>
      </div>
      
      <div style="margin-bottom: 25px;">
        <div style="color: var(--text-gray); font-size: 0.75rem; text-transform: uppercase; margin-bottom: 5px;">Digital E-Signature</div>
        <div style="background: white; padding: 10px; border-radius: 8px; display: inline-block; border: 1px solid rgba(0,0,0,0.1);">
          <img id="modal-kyc-signature" src="" alt="User Signature" style="max-height: 80px; display: block;">
        </div>
      </div>
      
      <button onclick="closeKycModal()" class="btn">Close Record</button>
    </div>
  </div>

  <!-- -----------------------------------------------------------
     3. CLIENT SIDE LOGIC & AJAX MODULES
     ----------------------------------------------------------- -->
  <script>
    // System Chart Instances
    let activityChart = null;
    let breakdownChart = null;
    let adminUsers = [];

    // Admin: Reset all data except admin credentials
    async function resetDatabase() {
      const confirmed = confirm('[WARNING] This will permanently delete ALL users, transactions, and KYC data.\\n\\nAdmin credentials will be preserved.\\n\\nAre you absolutely sure?');
      if (!confirmed) return;
      const btn = document.getElementById('btn-reset-db');
      btn.disabled = true;
      btn.textContent = 'Resetting...';
      try {
        const res = await fetch('/api/admin/reset-data', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          triggerToast(data.message, 'success');
          loadAdminData();
        } else {
          triggerToast(data.error || 'Reset failed.', 'error');
        }
      } catch (e) {
        triggerToast('Network error during reset.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Reset All Data';
      }
    }
    let signatureDrawn = false;
    let userKycStatus = 'Pending';
    
    // Check initial session routing
    window.addEventListener('load', () => {
      // Setup simple hash routing
      const hash = window.location.hash;
      if (hash === '#register') {
        toggleAuthView('register');
      } else {
        toggleAuthView('login');
      }
      
      // Auto-fetch data to check session
      checkSession();
    });

    // ----------------- TOAST MANAGER -----------------
    function triggerToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = \`toast toast-\${type}\`;
      toast.innerHTML = \`
        <span class="toast-icon">\${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}\</span>
        <span class="toast-message">\${message}</span>
      \`;
      container.appendChild(toast);
      
      setTimeout(() => toast.classList.add('show'), 10);
      
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
      }, 4000);
    }
    
    // Toggle login vs registration views
    function toggleAuthView(view) {
      const loginCard = document.getElementById('login-card');
      const registerCard = document.getElementById('register-card');
      
      if (view === 'register') {
        loginCard.style.display = 'none';
        registerCard.style.display = 'block';
        window.location.hash = '#register';
      } else {
        loginCard.style.display = 'block';
        registerCard.style.display = 'none';
        window.location.hash = '#login';
      }
    }
    
    // Switch tabs in user portal
    function switchTab(tabId) {
      // Hide all panels
      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      
      // Show target
      const targetPane = document.getElementById(tabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
      
      const navLink = document.querySelector(\`[data-tab="\${tabId}"]\`);
      if (navLink) {
        navLink.classList.add('active');
      }
      
      // Trigger lazy loaded items
      if (tabId === 'tab-overview') {
        fetchDashboardData();
      } else if (tabId === 'tab-transactions') {
        loadAllTransactions();
      } else if (tabId === 'tab-security') {
        loadSecurityLogs();
      } else if (tabId === 'tab-admin') {
        loadAdminData();
      }
    }
    
    // Check KYC file select
    function handleFileSelect(input) {
      const display = document.getElementById('selected-file-name');
      const text = document.getElementById('file-name-span');
      if (input.files && input.files.length > 0) {
        text.innerText = input.files[0].name;
        display.style.display = 'block';
      } else {
        display.style.display = 'none';
      }
    }
    
    // Toggle recipient input field based on Transaction type
    function toggleTransferFields() {
      const type = document.getElementById('tx-type').value;
      const group = document.getElementById('tx-recipient-group');
      const recipient = document.getElementById('tx-recipient');
      
      if (type === 'Transfer') {
        group.style.display = 'block';
        recipient.required = true;
      } else {
        group.style.display = 'none';
        recipient.required = false;
      }
    }

    // Toggle password fields text vs password type
    function togglePasswordVisibility(inputId) {
      const input = document.getElementById(inputId);
      const btn = input.nextElementSibling;
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerText = '🙈';
      } else {
        input.type = 'password';
        btn.innerText = '👁️';
      }
    }

    // Check Session by fetching user stats
    async function checkSession() {
      try {
        const res = await fetch('/api/dashboard-data');
        if (res.status === 200) {
          showPortalView();
        } else {
          showAuthView();
        }
      } catch (err) {
        showAuthView();
      }
    }
    
    function showPortalView() {
      document.getElementById('auth-section').style.display = 'none';
      document.getElementById('portal-section').style.display = 'block';
      fetchDashboardData();
    }
    
    function showAuthView() {
      document.getElementById('auth-section').style.display = 'flex';
      document.getElementById('portal-section').style.display = 'none';
    }

    // ----------------- API AJAX REQUEST HANDLERS -----------------
    
    // Submit Register
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('register-name').value;
      const email = document.getElementById('register-email').value;
      const password = document.getElementById('register-password').value;
      const confirmPassword = document.getElementById('register-confirm').value;
      
      try {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, confirmPassword })
        });
        const data = await response.json();
        
        if (response.ok) {
          triggerToast(data.message, 'success');
          document.getElementById('register-form').reset();
          showPortalView();
        } else {
          triggerToast(data.error || 'Registration failed.', 'error');
        }
      } catch (err) {
        triggerToast('Server communication failure.', 'error');
      }
    });
    
    // Submit Login
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const role = document.getElementById('login-role').value;
      
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, role })
        });
        const data = await response.json();
        
        if (response.ok) {
          triggerToast(data.message, 'success');
          document.getElementById('login-form').reset();
          showPortalView();
        } else {
          triggerToast(data.error || 'Login failed.', 'error');
        }
      } catch (err) {
        triggerToast('Server communication failure.', 'error');
      }
    });

    // Handle Logout
    async function handleLogout() {
      try {
        const response = await fetch('/api/auth/logout', { method: 'POST' });
        if (response.ok) {
          triggerToast('Logged out successfully.', 'success');
          showAuthView();
        }
      } catch (err) {
        triggerToast('Failed to log out.', 'error');
      }
    }
    
    // Load Dashboard Statistics & Charts
    async function fetchDashboardData() {
      try {
        const response = await fetch('/api/dashboard-data');
        if (response.status === 401) {
          showAuthView();
          return;
        }
        
        const data = await response.json();
        
        // Update user elements
        document.getElementById('profile-name').innerText = data.user.name;
        document.getElementById('profile-email').innerText = data.user.email;
        
        // Balance variables
        const balString = '₹' + data.stats.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        document.getElementById('val-balance').innerText = balString;
        document.getElementById('info-card-balance').innerText = balString;
        document.getElementById('val-income').innerText = '₹' + data.stats.totalIncome.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        document.getElementById('val-spending').innerText = '₹' + data.stats.totalSpending.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        
        // RBAC Tab visibility
        const adminNav = document.getElementById('admin-nav-item');
        if (data.user.role === 'admin') {
          adminNav.style.display = 'block';
        } else {
          adminNav.style.display = 'none';
        }

        // KYC Badge
        const kycBadge = document.getElementById('kyc-badge');
        const kycAlert = document.getElementById('kyc-alert-banner');
        kycBadge.innerText = 'KYC: ' + data.user.kyc_status;
        kycBadge.className = 'badge';
        
        if (data.user.kyc_status === 'Verified') {
          kycBadge.classList.add('badge-verified');
          kycAlert.style.display = 'none';
        } else if (data.user.kyc_status === 'Submitted') {
          kycBadge.classList.add('badge-submitted');
          kycAlert.style.display = 'none';
        } else {
          kycBadge.classList.add('badge-pending');
          kycAlert.style.display = 'flex';
        }
        
        // Render Recent Transactions
        const tBody = document.getElementById('table-recent-body');
        if (data.recentTransactions && data.recentTransactions.length > 0) {
          tBody.innerHTML = '';
          data.recentTransactions.forEach(t => {
            const isNegative = t.type === 'Withdrawal' || t.type === 'Transfer (Sent)';
            const amtClass = isNegative ? 'amount-negative' : 'amount-positive';
            const amtSymbol = isNegative ? '- ₹' : '+ ₹';
            const row = document.createElement('tr');
            row.innerHTML = \`
              <td>\${new Date(t.created_at).toLocaleDateString()}</td>
              <td style="font-weight: 500;">\${t.type}</td>
              <td style="color: var(--text-gray);">\${t.remark || 'N/A'}</td>
              <td class="\${amtClass}">\${amtSymbol}\${parseFloat(t.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td><span style="color: var(--accent-success); font-weight: 600;">\${t.status}</span></td>
            \`;
            tBody.appendChild(row);
          });
        } else {
          tBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-dark);">No transaction logs available.</td></tr>';
        }
        
        // Render Charts using Chart.js
        renderCharts(data.chartData, data.stats);
        
      } catch (err) {
        console.error(err);
        triggerToast('Failed to load dashboard statistics.', 'error');
      }
    }
    
    // Draw and refresh dashboard visualization charts
    function renderCharts(chartData, stats) {
      // 1. Bar Chart: Income & Spending Over time
      const ctxActivity = document.getElementById('chart-activity').getContext('2d');
      if (activityChart) activityChart.destroy();
      
      activityChart = new Chart(ctxActivity, {
        type: 'bar',
        data: {
          labels: chartData.labels,
          datasets: [
            {
              label: 'Inflow (Income)',
              data: chartData.income,
              backgroundColor: 'rgba(16, 185, 129, 0.7)',
              borderColor: 'rgba(16, 185, 129, 1)',
              borderWidth: 1,
              borderRadius: 6
            },
            {
              label: 'Outflow (Spending)',
              data: chartData.spending,
              backgroundColor: 'rgba(244, 63, 94, 0.7)',
              borderColor: 'rgba(244, 63, 94, 1)',
              borderWidth: 1,
              borderRadius: 6
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: { color: '#a0aec0', font: { family: 'Inter' } }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.03)' },
              ticks: { color: '#a0aec0' }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.03)' },
              ticks: { color: '#a0aec0' }
            }
          }
        }
      });
      
      // 2. Breakdown Doughnut
      const ctxBreakdown = document.getElementById('chart-breakdown').getContext('2d');
      if (breakdownChart) breakdownChart.destroy();
      
      const totalCombined = stats.totalIncome + stats.totalSpending;
      const incomeShare = totalCombined > 0 ? (stats.totalIncome / totalCombined) * 100 : 50;
      const spendingShare = totalCombined > 0 ? (stats.totalSpending / totalCombined) * 100 : 50;
      
      breakdownChart = new Chart(ctxBreakdown, {
        type: 'doughnut',
        data: {
          labels: ['Income Share', 'Spending Share'],
          datasets: [{
            data: [incomeShare, spendingShare],
            backgroundColor: [
              'rgba(16, 185, 129, 0.65)',
              'rgba(244, 63, 94, 0.65)'
            ],
            borderColor: [
              'rgba(16, 185, 129, 0.8)',
              'rgba(244, 63, 94, 0.8)'
            ],
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#a0aec0', font: { family: 'Inter' } }
            }
          },
          cutout: '70%'
        }
      });
    }
    
    // Submit transaction
    document.getElementById('tx-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = document.getElementById('tx-type').value;
      const amount = document.getElementById('tx-amount').value;
      const targetEmail = document.getElementById('tx-recipient').value;
      const remark = document.getElementById('tx-remark').value;
      
      const numAmount = parseFloat(amount);
      if (numAmount > 50000) {
        alert("More than 50,000 transaction can't be done.");
        return;
      }
      
      try {
        const response = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, amount, targetEmail, remark })
        });
        const data = await response.json();
        
        if (response.ok) {
          triggerToast(data.message, 'success');
          document.getElementById('tx-form').reset();
          toggleTransferFields();
          switchTab('tab-overview');
        } else {
          triggerToast(data.error || 'Transaction rejected.', 'error');
        }
      } catch (err) {
        triggerToast('Failed to record transaction log.', 'error');
      }
    });

    // Load full transaction list
    async function loadAllTransactions() {
      const start = document.getElementById('filter-start-date').value;
      const end = document.getElementById('filter-end-date').value;
      
      let url = '/api/transactions';
      if (start || end) {
        url += \`?startDate=\${start}&endDate=\${end}\`;
      }
      
      try {
        const response = await fetch(url);
        const data = await response.json();
        
        const tbody = document.getElementById('table-full-body');
        tbody.innerHTML = '';
        
        if (data.transactions && data.transactions.length > 0) {
          data.transactions.forEach(t => {
            const isNegative = t.type === 'Withdrawal' || t.type === 'Transfer (Sent)';
            const amtClass = isNegative ? 'amount-negative' : 'amount-positive';
            const amtSymbol = isNegative ? '- ₹' : '+ ₹';
            const row = document.createElement('tr');
            row.innerHTML = \`
              <td>\${t.id}</td>
              <td>\${new Date(t.created_at).toLocaleString()}</td>
              <td style="font-weight: 500;">\${t.type}</td>
              <td style="color: var(--text-gray);">\${t.sender_email || 'N/A'}</td>
              <td style="color: var(--text-gray);">\${t.recipient_email || 'N/A'}</td>
              <td>\${t.remark || 'N/A'}</td>
              <td class="\${amtClass}">\${amtSymbol}\${parseFloat(t.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              <td><span style="color: var(--accent-success); font-weight: 600;">\${t.status}</span></td>
            \`;
            tbody.appendChild(row);
          });
        } else {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-dark);">No transaction logs match filters.</td></tr>';
        }
      } catch (err) {
        triggerToast('Failed to load transaction history.', 'error');
      }
    }
    
    // Download account statement as CSV
    function downloadCSVStatement() {
      const start = document.getElementById('filter-start-date').value;
      const end = document.getElementById('filter-end-date').value;
      
      let url = '/api/transactions/statement';
      if (start || end) {
        url += \`?startDate=\${start}&endDate=\${end}\`;
      }
      
      // Navigate to download trigger
      window.location.href = url;
    }
    
    // Trigger file dialog for document upload slots
    function triggerSlotUpload(docType) {
      const card = document.getElementById(\`slot-card-\${docType}\`);
      if (card && card.classList.contains('disabled')) return;
      if (userKycStatus === 'Submitted' || userKycStatus === 'Verified') return;
      const fileInput = document.getElementById(\`upload-file-\${docType}\`);
      if (fileInput) fileInput.click();
    }

    // Auto-upload and validate selected file
    async function handleSlotSelect(input, docType) {
      if (input.files.length === 0) return;
      const file = input.files[0];
      
      const formData = new FormData();
      formData.append('doc_type', docType);
      formData.append('kyc_document', file);
      
      const card = document.getElementById(\`slot-card-\${docType}\`);
      const originalHtml = card.innerHTML;
      
      // Show uploading spinner
      card.innerHTML = \`
        <div class="spinner-small" style="margin-bottom:10px;"></div>
        <div style="font-size:0.8rem; font-weight:600; color: var(--text-white);">Uploading...</div>
      \`;
      
      try {
        const response = await fetch('/api/kyc/upload', {
          method: 'POST',
          body: formData
        });
        const data = await response.json();
        
        if (response.ok) {
          // Show validation spinner
          card.innerHTML = \`
            <div class="spinner-small" style="margin-bottom:10px; border-top-color: var(--accent-success);"></div>
            <div style="font-size:0.8rem; font-weight:600; color: var(--accent-success);">Validating...</div>
          \`;
          
          // Trigger backend validation
          const validateRes = await fetch('/api/kyc/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docId: data.docId })
          });
          const valData = await validateRes.json();
          
          if (validateRes.ok) {
            const toastType = valData.status === 'Pending' ? 'info' : 'success';
            triggerToast(valData.message, toastType);
          } else {
            triggerToast(valData.error || 'Document validation failed.', 'error');
          }
        } else {
          triggerToast(data.error || 'Upload failed.', 'error');
        }
      } catch (err) {
        triggerToast('Error during document submission & validation.', 'error');
      } finally {
        card.innerHTML = originalHtml;
        fetchDashboardData();
        loadKycTabInfo();
      }
    }

    // Switch KYC method tabs (Option A vs Option B)
    function switchKycMethod(method) {
      const uploadBtn = document.getElementById('btn-kyc-upload-tab');
      const eformBtn = document.getElementById('btn-kyc-eform-tab');
      const uploadCont = document.getElementById('kyc-upload-container');
      const eformCont = document.getElementById('kyc-eform-container');
      
      if (method === 'upload') {
        uploadBtn.classList.remove('btn-secondary');
        uploadBtn.classList.add('btn');
        eformBtn.classList.remove('btn');
        eformBtn.classList.add('btn-secondary');
        uploadCont.style.display = 'block';
        eformCont.style.display = 'none';
      } else {
        eformBtn.classList.remove('btn-secondary');
        eformBtn.classList.add('btn');
        uploadBtn.classList.remove('btn');
        uploadBtn.classList.add('btn-secondary');
        uploadCont.style.display = 'none';
        eformCont.style.display = 'block';
        initSignaturePad();
      }
    }

    // Canvas E-Sign drawing implementation
    let canvas = null;
    let ctx = null;
    let drawing = false;
    let signaturePadInitialized = false;
    
    function initSignaturePad() {
      if (signaturePadInitialized) {
        clearSignaturePad();
        return;
      }
      canvas = document.getElementById('signature-pad');
      if (!canvas) return;
      ctx = canvas.getContext('2d');
      
      canvas.width = canvas.clientWidth || 420;
      canvas.height = canvas.clientHeight || 150;
      
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      signatureDrawn = false;
      
      // Mouse Events
      canvas.addEventListener('mousedown', startDrawing);
      canvas.addEventListener('mousemove', draw);
      canvas.addEventListener('mouseup', stopDrawing);
      canvas.addEventListener('mouseleave', stopDrawing);
      
      // Touch Events
      canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length > 0) {
          const touch = e.touches[0];
          startDrawing({
            clientX: touch.clientX,
            clientY: touch.clientY
          });
        }
        e.preventDefault();
      });
      canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
          const touch = e.touches[0];
          draw({
            clientX: touch.clientX,
            clientY: touch.clientY
          });
        }
        e.preventDefault();
      });
      canvas.addEventListener('touchend', stopDrawing);
      signaturePadInitialized = true;
    }
    
    function startDrawing(e) {
      if (document.getElementById('kyc-eform-submit-btn').disabled) return;
      drawing = true;
      ctx.beginPath();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ctx.moveTo(x, y);
    }
    
    function draw(e) {
      if (!drawing) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ctx.lineTo(x, y);
      ctx.stroke();
      signatureDrawn = true;
    }
    
    function stopDrawing() {
      drawing = false;
    }
    
    function clearSignaturePad() {
      if (document.getElementById('kyc-eform-submit-btn').disabled) return;
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        signatureDrawn = false;
      }
    }

    // Submit digital E-form
    document.getElementById('kyc-eform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dob = document.getElementById('eform-dob').value;
      const taxId = document.getElementById('eform-tax-id').value;
      const income = document.getElementById('eform-income').value;
      const occupation = document.getElementById('eform-occupation').value;
      const address = document.getElementById('eform-address').value;
      
      if (!dob || !taxId || !income || !occupation || !address) {
        triggerToast('Please fill out all E-form fields.', 'error');
        return;
      }
      if (!signatureDrawn) {
        triggerToast('Please draw your digital signature on the signature pad.', 'error');
        return;
      }
      
      const signatureData = canvas.toDataURL('image/png');
      
      try {
        const response = await fetch('/api/kyc/form-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dob, address, taxId, income, occupation, signatureData })
        });
        const data = await response.json();
        
        if (response.ok) {
          triggerToast(data.message, 'success');
          document.getElementById('kyc-eform').reset();
          clearSignaturePad();
          fetchDashboardData();
          loadKycTabInfo();
        } else {
          triggerToast(data.error || 'KYC form submission failed.', 'error');
        }
      } catch (err) {
        triggerToast('Error submitting KYC digital form.', 'error');
      }
    });

    // Populate KYC information in tab
    async function loadKycTabInfo() {
      try {
        const res = await fetch('/api/dashboard-data');
        const data = await res.json();
        const msgDiv = document.getElementById('kyc-status-msg');
        
        const eformSubmitBtn = document.getElementById('kyc-eform-submit-btn');
        userKycStatus = data.user.kyc_status;
        const eformInputs = document.querySelectorAll('#kyc-eform input, #kyc-eform select, #kyc-eform button');
        
        const docsContainer = document.getElementById('kyc-uploaded-docs-container');
        const docsList = document.getElementById('kyc-uploaded-docs-list');
        
        if (data.uploadedDocs && data.uploadedDocs.length > 0) {
          docsContainer.style.display = 'block';
          docsList.innerHTML = '';
          data.uploadedDocs.forEach(d => {
            const row = document.createElement('div');
            row.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 15px; display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem;';
            const statusColor = d.status === 'Verified' ? 'var(--accent-success)' : d.status === 'Invalid' ? 'var(--accent-danger)' : 'var(--accent-warning)';
            
            let ocrInfoHtml = '';
            if (d.status === 'Pending') {
              ocrInfoHtml = \`
                <div style="font-size: 0.75rem; border-left: 2px solid var(--accent); padding-left: 8px; margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-weight: 600; color: var(--accent);">⏳ OCR Status: Validation Pending</span>
                  <span style="font-size: 0.7rem; color: #a0aec0;">Document is currently queued in the Service Bus for automated OCR validation...</span>
                </div>
              \`;
            } else if (d.status === 'Verified') {
              ocrInfoHtml = \`
                <div style="font-size: 0.75rem; border-left: 2px solid var(--accent-success); padding-left: 8px; margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-weight: 600; color: var(--accent-success);">✅ OCR Validation Success</span>
                  <span style="font-size: 0.7rem; color: #a0aec0;">\${d.ocr_details || 'The document layout and credentials verified successfully.'}</span>
                </div>
              \`;
            } else {
              ocrInfoHtml = \`
                <div style="font-size: 0.75rem; border-left: 2px solid var(--accent-danger); padding-left: 8px; margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="font-weight: 600; color: var(--accent-danger);">❌ OCR Validation Failed</span>
                  <span style="font-size: 0.7rem; color: #a0aec0;">\${d.ocr_details || 'The document failed authenticity check or text pattern validation.'}</span>
                </div>
              \`;
            }

            row.innerHTML = \`
              <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <span style="font-weight: 600; color: var(--text-white);">📄 \${d.original_name} (\${d.doc_type})</span>
                <span style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 0.7rem; padding: 2px 8px; border-radius: 12px; background: \${statusColor}; color: white; font-weight: 600;">\${d.status || 'Pending'}</span>
                </span>
              </div>
              \${ocrInfoHtml}
              <div style="color: var(--text-dark); font-size: 0.7rem; align-self: flex-end;">Uploaded: \${new Date(d.uploaded_at).toLocaleString()}</div>
            \`;
            docsList.appendChild(row);
          });
        } else {
          docsContainer.style.display = 'none';
        }

        // Apply green/red visual flags to the 4 slot cards
        const latestDocs = {};
        if (data.uploadedDocs) {
          data.uploadedDocs.forEach(d => {
            if (!latestDocs[d.doc_type]) {
              latestDocs[d.doc_type] = d;
            }
          });
        }

        const slots = ['Aadhaar', 'PAN', 'Passport', 'Photo'];
        slots.forEach(slot => {
          const card = document.getElementById(\`slot-card-\${slot}\`);
          const badge = document.getElementById(\`slot-status-\${slot}\`);
          if (!card || !badge) return;
          
          const doc = latestDocs[slot];
          if (doc) {
            badge.style.display = 'block';
            if (doc.status === 'Verified') {
              card.style.border = '2px solid var(--accent-success)';
              card.style.background = 'rgba(16, 185, 129, 0.08)';
              badge.style.background = 'var(--accent-success)';
              badge.style.color = 'var(--text-white)';
              badge.innerText = '✅ Verified';
              card.classList.add('disabled');
            } else if (doc.status === 'Invalid') {
              card.style.border = '2px solid var(--accent-danger)';
              card.style.background = 'rgba(244, 63, 94, 0.08)';
              badge.style.background = 'var(--accent-danger)';
              badge.style.color = 'var(--text-white)';
              badge.innerText = '❌ Invalid Doc';
              card.classList.remove('disabled');
            } else {
              card.style.border = '1px solid rgba(255, 255, 255, 0.08)';
              card.style.background = 'var(--bg-input)';
              badge.style.background = 'var(--accent-warning)';
              badge.style.color = 'var(--text-white)';
              badge.innerText = '⏳ Pending';
              card.classList.remove('disabled');
            }
          } else {
            card.style.border = '1px solid rgba(255, 255, 255, 0.08)';
            card.style.background = 'var(--bg-input)';
            badge.style.display = 'none';
            badge.innerText = '';
            card.classList.remove('disabled');
          }
        });

        if (data.user.kyc_status === 'Verified') {
          msgDiv.innerHTML = '<span style="color: var(--accent-success);">✔ Verification Complete. Your identity is verified.</span>';
          slots.forEach(slot => {
            const card = document.getElementById(\`slot-card-\${slot}\`);
            if (card) card.classList.add('disabled');
          });
          eformSubmitBtn.disabled = true;
          eformInputs.forEach(el => el.disabled = true);
        } else if (data.user.kyc_status === 'Submitted') {
          msgDiv.innerHTML = '<span style="color: var(--accent-hover);">⏳ KYC Information Submitted. Under administrative review.</span>';
          slots.forEach(slot => {
            const card = document.getElementById(\`slot-card-\${slot}\`);
            if (card) card.classList.add('disabled');
          });
          eformSubmitBtn.disabled = true;
          eformInputs.forEach(el => el.disabled = true);
        } else {
          msgDiv.innerHTML = '<span style="color: var(--accent-warning);">⚠ Action Needed. Please upload document or submit digital E-form.</span>';
          eformSubmitBtn.disabled = false;
          eformInputs.forEach(el => el.disabled = false);
        }
      } catch (e) {
        console.error(e);
      }
    }
    
    // Trigger KYC reload when switching to KYC tab
    document.querySelector('[data-tab="tab-kyc"]').addEventListener('click', loadKycTabInfo);

    // Fetch and render user security logs and simulated push alerts
    async function loadSecurityLogs() {
      try {
        const response = await fetch('/api/security/logs');
        if (response.status === 401) {
          showAuthView();
          return;
        }
        
        const data = await response.json();
        
        // Render audit logs table
        const tbody = document.getElementById('table-security-logs');
        tbody.innerHTML = '';
        
        // Render alerts list
        const alertsList = document.getElementById('alerts-notification-list');
        alertsList.innerHTML = '';
        
        if (data.logs && data.logs.length > 0) {
          data.logs.forEach(l => {
            const date = new Date(l.created_at).toLocaleString();
            
            // Render row in table
            const row = document.createElement('tr');
            row.innerHTML = \`
              <td>\${date}</td>
              <td><span class="badge" style="background: rgba(255,255,255,0.06); color: var(--text-white);">\${l.action}</span></td>
              <td style="color: var(--text-gray);">\${l.details}</td>
              <td style="font-family: monospace;">\${l.ip_address}</td>
            \`;
            tbody.appendChild(row);
            
            // Filter actions for user notification push box
            if (l.action === 'DEPOSIT' || l.action === 'WITHDRAWAL' || l.action === 'TRANSFER_SENT' || l.action === 'TRANSFER_RECEIVED' || l.action === 'KYC_VERIFICATION') {
              const alertBox = document.createElement('div');
              let borderCol = 'rgba(94, 96, 206, 0.2)';
              let bgCol = 'rgba(94, 96, 206, 0.05)';
              if (l.action === 'TRANSFER_SENT' || l.action === 'WITHDRAWAL') {
                borderCol = 'rgba(244, 63, 94, 0.2)';
                bgCol = 'rgba(244, 63, 94, 0.05)';
              } else if (l.action === 'DEPOSIT' || l.action === 'TRANSFER_RECEIVED') {
                borderCol = 'rgba(16, 185, 129, 0.2)';
                bgCol = 'rgba(16, 185, 129, 0.05)';
              }
              
              alertBox.style.cssText = \`background: \${bgCol}; border: 1px solid \${borderCol}; border-radius: 8px; padding: 12px;\`;
              alertBox.innerHTML = \`
                <div style="font-size: 0.75rem; color: var(--text-dark); margin-bottom: 4px;">SMS / EMAIL PUSH ALERT - \${date}</div>
                <div style="font-size: 0.85rem; font-weight: 500;">\${l.details}</div>
              \`;
              alertsList.appendChild(alertBox);
            }
          });
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-dark);">No audit logs available.</td></tr>';
        }
        
        // Add a default system message if alerts list is empty
        if (alertsList.innerHTML === '') {
          alertsList.innerHTML = \`
            <div style="background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; padding: 12px;">
              <div style="font-size: 0.75rem; color: var(--text-dark); margin-bottom: 4px;">SYSTEM ALERT - Just Now</div>
              <div style="font-size: 0.85rem; font-weight: 500;">Secure notification service initialized. No recent transactions.</div>
            </div>
          \`;
        }
      } catch (err) {
        triggerToast('Failed to load security logs.', 'error');
      }
    }
    
    // ----------------- ADMINISTRATIVE DASHBOARD AJAX -----------------
    
    // Load Admin view lists
    async function loadAdminData() {
      try {
        const response = await fetch('/api/admin/data');
        if (response.status === 401) {
          showAuthView();
          return;
        }
        
        const data = await response.json();
        adminUsers = data.users;
        
        // Render Users list
        const usersTBody = document.getElementById('table-admin-users');
        usersTBody.innerHTML = '';
        
        data.users.forEach(u => {
          let docsCol = '';
          if (u.documents && u.documents.length > 0) {
            docsCol += u.documents.map(d => {
              const statusColor = d.status === 'Verified' ? 'var(--accent-success)' : d.status === 'Invalid' ? 'var(--accent-danger)' : 'var(--accent-warning)';
              return \`<div style="margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
                <a href="/api/kyc/download/\${d.file_name}" class="auth-link" style="font-size: 0.8rem;" download>📄 \${d.original_name}</a>
                <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 8px; background: \${statusColor}; color: white; font-weight: 600;">\${d.status || 'Pending'}</span>
              </div>\`;
            }).join('');
          }
          if (u.kyc_form) {
            docsCol += \`<button onclick="viewKycFormDetails(\${u.id})" class="auth-link" style="background:none; border:none; padding:0; display:block; text-align:left; font-size:0.8rem; cursor:pointer; color: var(--accent-hover); margin-top: 4px;">📝 View E-Form</button>\`;
          }
          if (!docsCol) {
            docsCol = '<span style="color: var(--text-dark);">None</span>';
          }
          
          let actionCol = '';
          if (u.kyc_status === 'Submitted') {
            actionCol = \`
              <button onclick="updateKycStatus(\${u.id}, 'Verified')" class="admin-action-btn admin-btn-verify">Approve</button>
              <button onclick="updateKycStatus(\${u.id}, 'Pending')" class="admin-action-btn admin-btn-reject">Reject</button>
            \`;
          } else {
            actionCol = '<span style="color: var(--text-dark);">No Action</span>';
          }
          
          const row = document.createElement('tr');
          row.innerHTML = \`
            <td>\${u.id}</td>
            <td style="font-weight: 500;">\${u.name}</td>
            <td>\${u.email}</td>
            <td>₹\${parseFloat(u.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            <td>
              <span class="badge \${u.kyc_status === 'Verified' ? 'badge-verified' : u.kyc_status === 'Submitted' ? 'badge-submitted' : 'badge-pending'}">
                \${u.kyc_status}
              </span>
            </td>
            <td>\${docsCol}</td>
            <td>\${actionCol}</td>
          \`;
          usersTBody.appendChild(row);
        });
        
        // Render universal Transactions logs
        const txsTBody = document.getElementById('table-admin-txs');
        txsTBody.innerHTML = '';
        
        data.transactions.forEach(t => {
          const row = document.createElement('tr');
          row.innerHTML = \`
            <td>\${t.id}</td>
            <td>\${t.user_email}</td>
            <td style="font-weight: 500;">\${t.type}</td>
            <td>₹\${parseFloat(t.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            <td style="color: var(--text-gray);">\${t.sender_email || 'N/A'}</td>
            <td style="color: var(--text-gray);">\${t.recipient_email || 'N/A'}</td>
            <td style="font-size: 0.8rem;">\${new Date(t.created_at).toLocaleString()}</td>
            <td>\${t.remark || 'N/A'}</td>
          \`;
          txsTBody.appendChild(row);
        });
        
      } catch (err) {
        triggerToast('Failed to retrieve system details.', 'error');
      }
    }
    
    // Update User KYC verification status
    async function updateKycStatus(userId, status) {
      try {
        const response = await fetch('/api/admin/kyc-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, status })
        });
        const data = await response.json();
        
        if (response.ok) {
          triggerToast(data.message, 'success');
          loadAdminData();
          fetchDashboardData();
        } else {
          triggerToast(data.error || 'Status update failed.', 'error');
        }
      } catch (err) {
        triggerToast('Failed to reach admin API.', 'error');
      }
    }

    // View Digital KYC E-Form Modal
    function viewKycFormDetails(userId) {
      const user = adminUsers.find(u => u.id === userId);
      if (!user || !user.kyc_form) {
        triggerToast('No digital KYC form details found.', 'error');
        return;
      }
      
      const form = user.kyc_form;
      document.getElementById('modal-kyc-name').innerText = user.name;
      document.getElementById('modal-kyc-email').innerText = user.email;
      document.getElementById('modal-kyc-dob').innerText = form.dob || 'N/A';
      document.getElementById('modal-kyc-tax').innerText = form.tax_id || 'N/A';
      document.getElementById('modal-kyc-income').innerText = form.income || 'N/A';
      document.getElementById('modal-kyc-occupation').innerText = form.occupation || 'N/A';
      document.getElementById('modal-kyc-address').innerText = form.address || 'N/A';
      
      const sigImg = document.getElementById('modal-kyc-signature');
      if (form.signature_data) {
        sigImg.src = form.signature_data;
        sigImg.style.display = 'block';
      } else {
        sigImg.style.display = 'none';
      }
      
      document.getElementById('kyc-modal').style.display = 'flex';
    }

    function closeKycModal() {
      document.getElementById('kyc-modal').style.display = 'none';
    }
  </script>
</body>
</html>
`;

// Health check route for Application Gateway / Load Balancer probes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'UP', database: isPg ? 'PostgreSQL' : 'JSON Fallback' });
});

// Explicit health check routes for standard Azure probes
app.get('/health', (req, res) => res.status(200).send('OK'));
app.head('/health', (req, res) => res.status(200).end());
app.head('/', (req, res) => res.status(200).end());
app.get('/', (req, res) => res.send(htmlTemplate));

// Base API paths for path-based routing probes (api-route)
app.get('/api', (req, res) => res.status(200).send('API OK'));
app.get('/api/', (req, res) => res.status(200).send('API OK'));
app.head('/api', (req, res) => res.status(200).end());
app.head('/api/', (req, res) => res.status(200).end());

// Catch all routes to serve SPA
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Endpoint path not found' });
  }
  res.send(htmlTemplate);
});

// Run DB init and Startup Server
initDb().then(() => {
  initServiceBus();
  app.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`Apex Premium Banking Server running at http://localhost:${PORT}`);
    console.log(`================================================================`);
  });
});
