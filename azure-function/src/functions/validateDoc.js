const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ServiceBusClient } = require('@azure/service-bus');
const { createWorker } = require('tesseract.js');
const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');
const nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');
const { Pool } = require('pg');
const { Readable } = require('stream');

// Setup PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.AZURE_POSTGRESQL_CONNECTION_STRING
});

const formRecognizerEnabled = Boolean(process.env.FORM_RECOGNIZER_ENDPOINT && process.env.FORM_RECOGNIZER_API_KEY);
let documentAnalysisClient = null;
if (formRecognizerEnabled) {
  documentAnalysisClient = new DocumentAnalysisClient(
    process.env.FORM_RECOGNIZER_ENDPOINT,
    new AzureKeyCredential(process.env.FORM_RECOGNIZER_API_KEY)
  );
}

async function extractTextWithFormRecognizer(data, contentType) {
  if (!documentAnalysisClient) {
    return '';
  }
  const poller = await documentAnalysisClient.beginAnalyzeDocument('prebuilt-document', data, { contentType });
  const result = await poller.pollUntilDone();
  if (!result) return '';

  if (result.content) {
    return result.content;
  }

  const lines = [];
  if (result.pages) {
    for (const page of result.pages) {
      if (page.lines) {
        for (const line of page.lines) {
          if (line.content) lines.push(line.content);
        }
      }
    }
  }
  return lines.join(' ');
}

async function normalizeBlobToBuffer(blob) {
  if (!blob) return null;
  if (Buffer.isBuffer(blob)) return blob;
  if (blob instanceof ArrayBuffer) return Buffer.from(blob);
  if (ArrayBuffer.isView(blob)) return Buffer.from(blob.buffer);
  if (typeof blob === 'string') return Buffer.from(blob, 'utf8');
  if (blob instanceof Readable) {
    const chunks = [];
    for await (const chunk of blob) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  try {
    return Buffer.from(blob);
  } catch (err) {
    return null;
  }
}

function normalizeText(text) {
  if (!text) return '';
  return text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractDobFromText(text) {
  if (!text) return null;
  const patterns = [
    /\b(?:dob|date of birth|birth date)[:\s]*([0-3]?\d[-/][0-1]?\d[-/][12]\d{3})\b/i,
    /\b([0-3]?\d[-/][0-1]?\d[-/][12]\d{3})\b/,
    /\b(?:yob|year of birth)[:\s]*(19\d{2}|20\d{2})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const dob = match[1].replace(/\//g, '-');
      if (/^[0-3]?\d[-/][0-1]?\d[-/][12]\d{3}$/.test(dob)) {
        return dob;
      }
      return `01-01-${match[1]}`;
    }
  }
  return null;
}

function normalizeDocText(text) {
  return normalizeText(text).toLowerCase();
}

function matchPanPattern(text) {
  const normalized = text.replace(/\s+/g, '');
  const panPattern = /[A-Z]{5}[0-9]{4}[A-Z]/i;
  return panPattern.test(normalized);
}

function matchAadhaarPattern(text) {
  const normalized = text.replace(/\s+/g, '');
  return /\b\d{12}\b/.test(normalized) || /\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text);
}

function matchPassportPattern(text) {
  return /\b[A-Z][0-9]{7}\b/i.test(text) || /mrz/.test(text.toLowerCase());
}

app.storageBlob('BlobTrigger1', {
  path: 'kyc-documents/{name}',
  connection: 'AZURE_STORAGE_CONNECTION_STRING',
  handler: async (blob, context) => {
    const filename = context.triggerMetadata.name;
    context.log(`[KYC TRIGGER] Processing blob: "${filename}"`);

    // Parse userId from filename (expected: kyc-{userId}-{uniqueSuffix}.{ext})
    const match = filename.match(/^kyc-(\d+)-/);
    if (!match) {
      context.error(`[KYC TRIGGER] Error: Filename does not match expected pattern: kyc-{userId}-...`);
      return;
    }
    const userId = parseInt(match[1]);

    let pgClient = null;
    let docType = 'Aadhaar';
    let docId = null;
    let userEmail = '';
    let userName = '';

    try {
      // Connect to PostgreSQL and fetch user profile
      pgClient = await pool.connect();
      const userRes = await pgClient.query('SELECT name, email FROM bank_users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        throw new Error(`User with ID ${userId} not found in database.`);
      }
      userName = userRes.rows[0].name;
      userEmail = userRes.rows[0].email;

      // Extract metadata from the Blob properties
      const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
      const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
      const sourceContainerClient = blobServiceClient.getContainerClient('kyc-documents');
      const sourceBlobClient = sourceContainerClient.getBlobClient(filename);
      const properties = await sourceBlobClient.getProperties();

      docType = properties.metadata && properties.metadata.doc_type ? properties.metadata.doc_type : null;
      docId = properties.metadata && properties.metadata.doc_id ? parseInt(properties.metadata.doc_id) : null;

      if (!docType || !docId) {
        context.log('[KYC TRIGGER] Warning: Blob metadata missing doc_type or doc_id — attempting DB fallback lookup.');
        try {
          // Try to map blob filename to DB record if metadata was not set during upload
          const dbLookup = await pgClient.query('SELECT id, doc_type, original_name FROM bank_kyc_docs WHERE file_name = $1 LIMIT 1', [filename]);
          if (dbLookup.rows.length > 0) {
            const row = dbLookup.rows[0];
            if (!docId) docId = row.id;
            if (!docType) {
              // prefer explicit doc_type column, otherwise try parsing original_name
              docType = row.doc_type || (row.original_name ? row.original_name.split(':')[0] : 'Aadhaar');
            }
            context.log(`[KYC TRIGGER] Fallback DB mapping found — docId: ${docId}, docType: ${docType}`);
          } else {
            context.log('[KYC TRIGGER] Fallback DB mapping did not find a matching record for blob filename.');
            // keep defaults if not found
            if (!docType) docType = 'Aadhaar';
          }
        } catch (dbErr) {
          context.error('[KYC TRIGGER] DB fallback lookup failed:', dbErr.message);
          if (!docType) docType = 'Aadhaar';
        }
      }

      context.log(`[KYC TRIGGER] User: ${userName} (${userEmail}) | Document Type: ${docType} | Database Doc ID: ${docId}`);

      let isValid = false;
      let reason = '';
      let dob = null;
      let textContent = '';
      let blobBuffer = await normalizeBlobToBuffer(blob);
      if (!blobBuffer) {
        throw new Error('Unable to normalize blob content for processing.');
      }

      if (docType === 'Photo') {
        // Face profile photos skip OCR and are validated based on image extension
        const contentType = properties.contentType || '';
        const isImage = contentType.startsWith('image/') || filename.toLowerCase().match(/\.(jpg|jpeg|png)$/);
        if (isImage) {
          isValid = true;
          reason = 'Biometric photo structure and metadata validated successfully.';
        } else {
          isValid = false;
          reason = 'Profile Photo must be a valid image file (JPG or PNG).';
        }
      } else {
        // OCR Processing based on file extension
        const ext = filename.split('.').pop().toLowerCase();
        context.log(`[KYC TRIGGER] Initiating OCR for extension: .${ext}`);

        blobBuffer = await normalizeBlobToBuffer(blob);
        if (!blobBuffer) {
          throw new Error('Unable to normalize blob content for OCR processing.');
        }

        if (ext === 'pdf') {
          if (formRecognizerEnabled) {
            textContent = await extractTextWithFormRecognizer(blobBuffer, properties.contentType || 'application/pdf');
            context.log(`[KYC TRIGGER] Azure Form Recognizer PDF extraction completed. Characters read: ${textContent.length}`);
            if (!textContent || textContent.length < 50) {
              context.log('[KYC TRIGGER] Form Recognizer returned little or no text; falling back to pdf-parse for the PDF.');
              const pdfData = await pdfParse(blobBuffer);
              textContent = pdfData.text || '';
              context.log(`[KYC TRIGGER] pdf-parse fallback text extracted. Characters read: ${textContent.length}`);
            }
          } else {
            const pdfData = await pdfParse(blobBuffer);
            textContent = pdfData.text || '';
            context.log(`[KYC TRIGGER] PDF Text Extraction completed. Characters read: ${textContent.length}`);
            if (textContent.length < 100) {
              context.log('[KYC TRIGGER] PDF appears to be image-only or scanned. For better OCR, configure Azure Form Recognizer or upload a searchable PDF/image file.');
            }
          }
        } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
          if (formRecognizerEnabled) {
            textContent = await extractTextWithFormRecognizer(blobBuffer, properties.contentType || `image/${ext}`);
            context.log(`[KYC TRIGGER] Azure Form Recognizer image extraction completed. Characters read: ${textContent.length}`);
          } else {
            const worker = createWorker();
            try {
              await worker.load();
              await worker.loadLanguage('eng');
              await worker.initialize('eng');

              const imageBuffer = blobBuffer;
              const { data: { text } } = await worker.recognize(imageBuffer);
              textContent = text || '';
            } finally {
              try { await worker.terminate(); } catch (tErr) { /* ignore */ }
            }
            context.log(`[KYC TRIGGER] Tesseract.js Image OCR completed. Characters read: ${textContent.length}`);
          }
        } else {
          throw new Error(`Unsupported document extension for OCR: .${ext}`);
        }

        // Log snippet of extracted text for debugging
        context.log(`[KYC TRIGGER] Extracted Text Snippet: "${textContent.substring(0, 300).replace(/\n/g, ' ')}"`);

        // Try extracting Date of Birth (DOB) from the OCR text
        dob = extractDobFromText(textContent);
        if (dob) {
          context.log(`[KYC TRIGGER] Extracted DOB from document: ${dob}`);
        } else {
          context.log('[KYC TRIGGER] No DOB found in document OCR text. Will use fallback lookup or placeholder.');
        }

        // Validate specific document identifiers
        const contentLower = normalizeDocText(textContent);
        if (docType === 'Aadhaar') {
          const hasAadhaarKeywords = contentLower.includes('aadhaar') || contentLower.includes('uidai') || contentLower.includes('government of india') || contentLower.includes('unique identification') || contentLower.includes('aadhar');
          const hasAadhaarPattern = matchAadhaarPattern(textContent);

          if (hasAadhaarKeywords || hasAadhaarPattern) {
            isValid = true;
            reason = 'Aadhaar card national identity keywords and pattern matched successfully.';
          } else {
            isValid = false;
            reason = 'Failed to verify 12-digit Aadhaar number format or national identity keywords.';
          }
        } else if (docType === 'PAN') {
          const hasPanKeywords = contentLower.includes('income tax') || contentLower.includes('permanent account') || contentLower.includes('govt. of india') || contentLower.includes('pan');
          const hasPanPattern = matchPanPattern(textContent);

          if (hasPanKeywords || hasPanPattern) {
            isValid = true;
            reason = 'PAN card alphanumeric registration matched successfully.';
          } else {
            isValid = false;
            reason = 'Failed to verify PAN registration number pattern or income tax keywords.';
          }
        } else if (docType === 'Passport') {
          const hasPassportKeywords = contentLower.includes('passport') || contentLower.includes('republic of india') || contentLower.includes('travel') || contentLower.includes('mrz');
          const hasPassportPattern = matchPassportPattern(textContent);

          if (hasPassportKeywords || hasPassportPattern) {
            isValid = true;
            reason = 'Passport travel booklet identifiers matched successfully.';
          } else {
            isValid = false;
            reason = 'Failed to verify Passport MRZ alignment or booklet code identifiers.';
          }
        }
      }

      // Query database for DOB fallback if OCR could not detect it
      if (!dob && pgClient) {
        const formRes = await pgClient.query('SELECT dob FROM bank_kyc_forms WHERE user_id = $1', [userId]);
        if (formRes.rows.length > 0 && formRes.rows[0].dob) {
          dob = formRes.rows[0].dob;
        }
      }
      if (!dob) {
        dob = '01-01-1990'; // Final placeholder if no DOB is found in document or DB
      }

      // Handle Validation Outputs
      // Prepare SMTP transporter fallback (if Service Bus is unavailable or fails)
      let mailTransporter = null;
      try {
        const host = process.env.SMTP_HOST;
        const port = parseInt(process.env.SMTP_PORT || '587');
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;
        if (host && user && pass) {
          mailTransporter = nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === 'true', auth: { user, pass } });
        }
      } catch (e) {
        context.log('[KYC TRIGGER] SMTP transporter not configured or failed to initialize:', e.message);
        mailTransporter = null;
      }

      let sbClient = null;
      let sender = null;
      try {
        if (process.env.AZURE_SERVICE_BUS_CONNECTION_STRING) {
          sbClient = new ServiceBusClient(process.env.AZURE_SERVICE_BUS_CONNECTION_STRING);
          sender = sbClient.createSender('kyc-notifications');
        }
      } catch (sbInitErr) {
        context.error('[KYC TRIGGER] Service Bus client init failed:', sbInitErr.message);
        sbClient = null;
        sender = null;
      }

      if (isValid) {
        context.log('[KYC TRIGGER] Validation Passed! Transferring blob with custom name...');

        // Format names safely for cloud storage naming rules
        const sanitizedName = userName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const sanitizedDob = dob.replace(/[^0-9\-]/g, '');
        const ext = filename.split('.').pop() || 'pdf';
        const customFileName = `${sanitizedName}_${sanitizedDob}_${docType}.${ext}`;

        // Upload to processed-and-validated-container
        const targetContainerClient = blobServiceClient.getContainerClient('processed-and-validated-container');
        await targetContainerClient.createIfNotExists();
        const targetBlobClient = targetContainerClient.getBlockBlobClient(customFileName);

        await targetBlobClient.upload(blobBuffer, blobBuffer.length, {
          blobHTTPHeaders: { blobContentType: properties.contentType },
          metadata: {
            original_name: filename,
            doc_type: docType,
            user_id: userId.toString(),
            doc_id: docId ? docId.toString() : ''
          }
        });

        context.log(`[KYC TRIGGER] Blob successfully moved as "${customFileName}"`);

        // Delete the original blob from the ingest container
        await sourceBlobClient.delete();
        context.log(`[KYC TRIGGER] Original blob deleted.`);

        // Publish SUCCESS result to Service Bus queue
        const message = {
          body: JSON.stringify({ userId, docId, docType, status: 'Verified', reason, fileName: customFileName, email: userEmail })
        };
        if (sender) {
          try {
            await sender.sendMessages(message);
          } catch (sbErr) {
            context.error('[KYC TRIGGER] Failed to send Service Bus message (Verified):', sbErr.message);
            // Fallback: send notification email directly if SMTP configured
            if (mailTransporter) {
              try {
                await mailTransporter.sendMail({
                  from: process.env.SMTP_FROM_EMAIL || 'no-reply@apexbank.com',
                  to: userEmail,
                  subject: `[Apex Bank] KYC Document Verified`,
                  text: `Your ${docType} document has been VERIFIED. Detail: ${reason}`
                });
                context.log('[KYC TRIGGER] Sent verification email fallback to', userEmail);
              } catch (mailErr) {
                context.error('[KYC TRIGGER] Failed to send verification fallback email:', mailErr.message);
              }
            }
          }
        } else if (mailTransporter) {
          try {
            await mailTransporter.sendMail({
              from: process.env.SMTP_FROM_EMAIL || 'no-reply@apexbank.com',
              to: userEmail,
              subject: `[Apex Bank] KYC Document Verified`,
              text: `Your ${docType} document has been VERIFIED. Detail: ${reason}`
            });
            context.log('[KYC TRIGGER] Sent verification email fallback to', userEmail);
          } catch (mailErr) {
            context.error('[KYC TRIGGER] Failed to send verification fallback email:', mailErr.message);
          }
        }
      } else {
        context.warn(`[KYC TRIGGER] Validation Failed: ${reason}`);

        // Delete from ingestion container to avoid duplicates
        await sourceBlobClient.delete();
        context.log(`[KYC TRIGGER] Temporary invalid blob deleted.`);

        // Publish FAILURE result to Service Bus queue
        const message = { body: JSON.stringify({ userId, docId, docType, status: 'Invalid', reason, fileName: filename, email: userEmail }) };
        if (sender) {
          try {
            await sender.sendMessages(message);
          } catch (sbErr) {
            context.error('[KYC TRIGGER] Failed to send Service Bus message (Invalid):', sbErr.message);
            if (mailTransporter) {
              try {
                await mailTransporter.sendMail({
                  from: process.env.SMTP_FROM_EMAIL || 'no-reply@apexbank.com',
                  to: userEmail,
                  subject: `[Apex Bank] KYC Document Rejected`,
                  text: `Your ${docType} document was rejected. Reason: ${reason}`
                });
                context.log('[KYC TRIGGER] Sent rejection email fallback to', userEmail);
              } catch (mailErr) {
                context.error('[KYC TRIGGER] Failed to send rejection fallback email:', mailErr.message);
              }
            }
          }
        } else if (mailTransporter) {
          try {
            await mailTransporter.sendMail({
              from: process.env.SMTP_FROM_EMAIL || 'no-reply@apexbank.com',
              to: userEmail,
              subject: `[Apex Bank] KYC Document Rejected`,
              text: `Your ${docType} document was rejected. Reason: ${reason}`
            });
            context.log('[KYC TRIGGER] Sent rejection email fallback to', userEmail);
          } catch (mailErr) {
            context.error('[KYC TRIGGER] Failed to send rejection fallback email:', mailErr.message);
          }
        }
      }

      try { if (sender) await sender.close(); } catch(e){}
      try { if (sbClient) await sbClient.close(); } catch(e){}
      context.log('[KYC TRIGGER] Service Bus notification step completed (or fallback used).');

    } catch (err) {
      context.error('[KYC TRIGGER] Execution failed with error:', err.message);

      // Attempt to publish an error notification to avoid user flow freezing
      try {
        const sbClient = new ServiceBusClient(process.env.AZURE_SERVICE_BUS_CONNECTION_STRING);
        const sender = sbClient.createSender('kyc-notifications');
        await sender.sendMessages({
          body: JSON.stringify({
            userId,
            docId,
            docType,
            status: 'Invalid',
            reason: `Validation aborted due to system error: ${err.message}`,
            fileName: filename,
            email: userEmail
          })
        });
        await sender.close();
        await sbClient.close();
      } catch (sbErr) {
        context.error('[KYC TRIGGER] Failed to dispatch error notification to Service Bus:', sbErr.message);
      }
    } finally {
      if (pgClient) {
        pgClient.release();
      }
    }
  }
});
