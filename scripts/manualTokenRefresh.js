// scripts/manualTokenRefresh.js
//
// Manually refreshes a Dhan access token for a given client and saves it to
// the database. Same code path as the 8 AM IST scheduler — useful when:
//   - The scheduler failed at 8 AM and you want to retry now
//   - A token expires mid-day (e.g. Dhan revoked it)
//   - You've just added a new client and want to prime their token
//   - You want to verify everything still works after a Dhan API change
//
// Usage (from /opt/gridbot-backend):
//     node scripts/manualTokenRefresh.js <clientUuid>
//
// Example:
//     node scripts/manualTokenRefresh.js b4bba6ad-9f9b-4f8b-be8f-9871edd66b9b
//
// To find a client's UUID, run: node scripts/addPinToClient.js and copy the UUID
// from the listed clients, then Ctrl+C to exit before it prompts for PIN.

require("dotenv").config();
const { encrypt, decrypt } = require("../src/services/encryption");
const db = require("../src/services/database");
const { refreshDhanToken } = require("../src/services/dhan");

async function main() {
  const clientId = process.argv[2];

  if (!clientId) {
    console.error("Usage: node scripts/manualTokenRefresh.js <clientUuid>");
    console.error("");
    console.error("Available clients:");
    const rows = await db.getAll("SELECT id, name, broker, active FROM clients ORDER BY created_at DESC");
    for (const r of rows) {
      console.error(`  ${r.id}  |  ${r.name}  |  broker: ${r.broker}  |  active: ${r.active}`);
    }
    process.exit(1);
  }

  // Basic UUID sanity check.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    console.error(`"${clientId}" does not look like a valid UUID. Aborting.`);
    process.exit(1);
  }

  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n=== Manual token refresh at ${ist} IST ===\n`);

  const row = await db.getOne(
    "SELECT id, name, broker, credentials_enc FROM clients WHERE id = $1",
    [clientId]
  );
  if (!row) {
    console.error(`Client ${clientId} not found. Aborting.`);
    process.exit(1);
  }

  const creds = decrypt(row.credentials_enc);
  console.log("Client:", row.name, "| broker:", row.broker);
  console.log("  client_id:  ", creds.client_id);
  console.log("  PIN set:    ", !!creds.pin, "(length:", creds.pin ? creds.pin.length : 0, ")");
  console.log("  TOTP set:   ", !!creds.totp_secret);
  console.log("");

  if (row.broker !== "Dhan") {
    console.error(`Broker ${row.broker} refresh is not yet implemented. Aborting.`);
    process.exit(1);
  }

  if (!creds.pin || !creds.totp_secret) {
    console.error("Client is missing pin or totp_secret in credentials. Aborting.");
    console.error("Run: node scripts/addPinToClient.js to add the pin.");
    process.exit(1);
  }

  const refreshed = await refreshDhanToken(creds.client_id, creds.totp_secret, creds.pin);

  if (!refreshed || !refreshed.accessToken) {
    console.error("FAILED - see log lines above for the error message from Dhan");
    await db.query(
      "INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1, FALSE, $2)",
      [clientId, `Manual refresh FAILED at ${ist} IST`]
    );
    process.exit(1);
  }

  creds.access_token = refreshed.accessToken;
  creds.expiry_time  = refreshed.expiryTime;

  await db.query(
    "UPDATE clients SET credentials_enc = $1, token_refreshed_at = NOW() WHERE id = $2",
    [encrypt(creds), clientId]
  );
  await db.query(
    "INSERT INTO token_refresh_log (client_id, success, message) VALUES ($1, TRUE, $2)",
    [clientId, `Manual refresh at ${ist} IST, expires ${refreshed.expiryTime}`]
  );

  console.log("SUCCESS");
  console.log("  New token preview:", refreshed.accessToken.substring(0, 20) + "...");
  console.log("  Expires at:       ", refreshed.expiryTime);
  console.log("  Client name:      ", refreshed.clientName);
  console.log("  Saved to DB:      YES");
  console.log("  Logged in token_refresh_log: YES");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nScript failed:", err.message);
    process.exit(1);
  });
