-- Stored National Grid logins (NG-login foundation, issues #6/#8). Additive:
-- introduces an NgLogin table and links Account rows to it via a nullable FK,
-- so existing env-bootstrapped accounts (loginId NULL) keep working unchanged.
-- The password is encrypted at rest with AES-256-GCM (key from NGRID_SECRET_KEY,
-- never stored here); ciphertext/iv/authTag are the base64 GCM components.

-- NgLogin: one stored credential, fanning out to several Account rows.
CREATE TABLE "NgLogin" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "status" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NgLogin_pkey" PRIMARY KEY ("id")
);

-- Account: nullable link back to the login it was discovered through. NULL for
-- accounts bootstrapped from env creds. ON DELETE SET NULL so deleting a login
-- orphans (not deletes) its accounts and their history.
ALTER TABLE "Account" ADD COLUMN "loginId" INTEGER;

ALTER TABLE "Account" ADD CONSTRAINT "Account_loginId_fkey" FOREIGN KEY ("loginId") REFERENCES "NgLogin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
