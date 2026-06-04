# Apex Premium Banking Portal: E2E Azure KYC Architecture

A premium, single-file self-contained banking web application written in Node.js (Express) coupled with a Blob-Triggered Azure Function that performs OCR verification and renames processed documents, coordinated asynchronously via Azure Service Bus.

This application runs perfectly in **two modes**:
1. **Local Fallback Mode:** Requires zero Azure configuration; uses local filesystem (`uploads/`), JSON DB (`database.json`), and in-memory events.
2. **Azure Cloud Mode:** Fully integrated enterprise cloud architecture using Azure App Service, Azure Functions, Azure Database for PostgreSQL, Blob Storage, Service Bus, and Application Gateway.

---

## Architecture Overview

This system is designed as a fully asynchronous Azure pipeline:

* Web App accepts user registration and KYC uploads.
* Uploads are stored in the `kyc-documents` blob container.
* Azure Function triggers on each new blob, validates the document using OCR, and conditionally moves it to `processed-and-validated-container`.
* Function publishes verification/rejection events to the `kyc-notifications` Service Bus queue.
* The Web App consumes those events, updates KYC status in the database, and notifies the user.

---

## Phase 1: Local Development & Fallback Setup

If you want to run the app locally without configuring Azure:

1. **Install Dependencies:**
   ```bash
   npm install
   ```
2. **Create `.env` for Local Mode:**
   ```env
   PORT=3000
   JWT_SECRET=banking_premium_app_secret_key_9988776655
   DB_SSL=false
   ```
3. **Run the App:**
   ```bash
   npm start
   # or for development: npm run dev
   ```
4. **Open the App:**
   Navigate to `http://localhost:3000`.

> Local fallback allows the app to run without Azure by storing files under `uploads/`, persisting records in `database.json`, and simulating the Service Bus delivery.

---

## Phase 2: Azure Cloud Resource Setup

These steps create the Azure foundation for the app.

### Step 1: Create a Resource Group
* Search for **Resource groups** in the Azure Portal and click **+ Create**.
* Use:
  * **Name:** `rg-apex-banking`
  * **Region:** `Central India` (or your region)

### Step 2: Create a Virtual Network & Subnets (Optional but Recommended)
* Search for **Virtual networks** -> Click **+ Create**.
* Use **Name:** `vnet-apex-banking`.
* Add these subnets:
  1. `snet-appgw` | `10.0.1.0/27`
  2. `snet-appservice` | `10.0.2.0/27`
  3. `snet-privateendpoints` | `10.0.3.0/26`
  4. `snet-postgres` | `10.0.4.0/28`
  5. `snet-function` | `10.0.5.0/27`

### Step 3: Create PostgreSQL Flexible Server
* Search for **Azure Database for PostgreSQL flexible servers** -> **+ Create**.
* Use:
  * **Server name:** `banking-app-db`
  * **Compute:** `Burstable B1ms`
  * **Admin:** `bankingapp` / `Apex@1234`
* Networking options:
  * If using VNet: enable **Private access** and select `vnet-apex-banking` → `snet-postgres`.
  * If public: enable Azure service access and allow App Service/Function App connections.

### Step 4: Create Storage Account
* Search for **Storage accounts** -> **+ Create**.
* Use:
  * **Name:** `saapexbanking`
  * **Redundancy:** `LRS`
* After deployment, create containers:
  * `kyc-documents`
  * `processed-and-validated-container`
* Copy the **Connection String** from **Access keys**.

### Step 5: Create Service Bus Namespace & Queue
* Search for **Service Bus** -> **+ Create**.
* Use:
  * **Namespace:** `sb-apex-notifications`
  * **Tier:** `Standard`
* Once created, add queue:
  * `kyc-notifications`
* Copy the **Primary Connection String** from `RootManageSharedAccessKey`.

---

## Phase 3: Configure & Deploy the Web App

### Create the Web App
* Search for **App Services** -> **+ Create** -> **Web App**.
* Use:
  * **Name:** `apex-banking`
  * **Runtime:** `Node.js 20 LTS`
  * **OS:** `Linux`
  * **Plan:** `Basic B1` in Central India
* If using VNet: attach `vnet-apex-banking` → `snet-appservice`.

### Add App Settings
Open the Web App configuration and add:
* `PORT=8080`
* `JWT_SECRET=banking_premium_app_secret_key_9988776655`
* `DATABASE_URL=postgres://bankingapp:Apex%401234@banking-app-db.postgres.database.azure.com:5432/autohub?sslmode=require`
* `AZURE_STORAGE_CONNECTION_STRING=[Storage connection string]`
* `AZURE_SERVICE_BUS_CONNECTION_STRING=[Service Bus connection string]`
* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

### Deploy the Web App
* Use VS Code deployment or GitHub Actions.
* For GitHub Actions, add the publish profile secret and push to `main`.

---

## Phase 4: Configure & Deploy the Azure Function

### Create the Function App
* Search for **Function App** -> **+ Create**.
* Use:
  * **Name:** `fn-apex-kyc-validator`
  * **Runtime:** `Node.js 20`
  * **OS:** `Linux`
  * **Hosting plan:** App Service Plan or Flex Consumption
  * **Storage:** `saapexbanking`
  * If using VNet: select `vnet-apex-banking` → `snet-function`

### Add App Settings
Add:
* `DATABASE_URL=postgres://bankingapp:Apex%401234@banking-app-db.postgres.database.azure.com:5432/autohub?sslmode=require`
* `AZURE_STORAGE_CONNECTION_STRING=[Storage connection string]`
* `AZURE_SERVICE_BUS_CONNECTION_STRING=[Service Bus connection string]`

### Deploy the Function Code
From the repo root:
```bash
cd azure-function
func azure functionapp publish fn-apex-kyc-validator
```

---

## Phase 5: Application Gateway / Health Probe Setup

If you route via Application Gateway, configure a health probe to avoid Azure App Service host mismatch:
* Host: `apex-banking.azurewebsites.net` (or your app URL)
* Path: `/health` or `/api/health`
* Protocol: `HTTPS`

---

## Phase 6: End-to-End Verification

1. Register a new user in the Web App.
2. Complete the KYC form and upload a document.
3. The app uploads to `kyc-documents`.
4. Azure Function runs OCR, validates the document, and publishes to `kyc-notifications`.
5. The Web App consumes the Service Bus message and updates database status.
6. The user receives an email notification.

---

## Cleanup & Reset

If the pipeline becomes stale:
1. Restart the Web App and Function App.
2. POST to `/api/admin/reset-data`.
3. Delete stale receipts from `azure-webjobs-hosts` if replaying the same blob name.
4. Upload a new file with a fresh name: `kyc-{userId}-{uniqueSuffix}.{ext}`.

> Reusing the same blob name can fail to retrigger the function when Azure keeps old receipt state.
