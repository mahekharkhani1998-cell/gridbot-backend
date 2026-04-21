// scripts/addPinToClient.js
//
// One-time script to add the Dhan 6-digit PIN to an existing client's
// encrypted credentials blob. Does not overwrite any other credential fields.
//
// Usage (run on the droplet, from /opt/gridbot-backend):
//     node scripts/addPinToClient.js
//
// It will prompt you for:
//   1. The client's database ID (a UUID) — copy from the frontend UI or DB
//   2. The 6-digit PIN (hidden input, not echoed to screen)
//
// Then it fetches the client's credentials_enc blob, decrypts, merges the PIN,
// re-encrypts, and writes it back. No other fields are touched.

require("dotenv").config();
const readline = require("readline");
const db = require("../src/services/database");
const { encrypt, decrypt, mask } = require("../src/services/encryption");

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (hidden) {
      // Stop echoing keystrokes while typing the PIN.
      const origWrite = rl._writeToOutput;
      rl._writeToOutput = function (str) {
        if (str.startsWith(question)) {
          origWrite.call(rl, str);
        } else {
          // Print a star for each character so the user sees progress.
          origWrite.call(rl, "*");
        }
      };
    }

    rl.question(question, (answer) => {
      if (hidden) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("\n=== Add PIN to client credentials ===\n");

  // List active clients so the user can identify the right one.
  const clients = await db.getAll(
    "SELECT id, name, broker, active FROM clients ORDER BY created_at DESC"
  );
  if (!clients.length) {
    console.error("No clients found in database. Aborting.");
    process.exit(1);
  }

  console.log("Existing clients:");
  for (const c of clients) {
    console.log(`  ${c.id}  |  ${c.name}  |  broker: ${c.broker}  |  active: ${c.active}`);
  }
  console.log("");

  const clientId = await prompt("Enter the client ID (UUID) to update: ");
  if (!clientId) {
    console.error("No client ID provided. Aborting.");
    process.exit(1);
  }

  const row = await db.getOne(
    "SELECT id, name, credentials_enc FROM clients WHERE id = $1",
    [clientId]
  );
  if (!row) {
    console.error(`Client ${clientId} not found. Aborting.`);
    process.exit(1);
  }

  let creds;
  try {
    creds = decrypt(row.credentials_enc);
  } catch (e) {
    console.error(`Failed to decrypt existing credentials: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nCurrent credentials for ${row.name} (masked):`);
  console.log(JSON.stringify(mask(creds), null, 2));
  console.log("");

  if (creds.pin) {
    const overwrite = await prompt("A PIN is already set. Overwrite? (yes/no): ");
    if (overwrite.toLowerCase() !== "yes") {
      console.log("Aborted. No changes made.");
      process.exit(0);
    }
  }

  const pin = await prompt("Enter the 6-digit Dhan PIN: ", { hidden: true });
  if (!/^\d{6}$/.test(pin)) {
    console.error("PIN must be exactly 6 digits. Aborting.");
    process.exit(1);
  }

  const pinConfirm = await prompt("Re-enter the PIN to confirm:   ", { hidden: true });
  if (pin !== pinConfirm) {
    console.error("PINs do not match. Aborting.");
    process.exit(1);
  }

  const updated = { ...creds, pin };
  const newEnc = encrypt(updated);

  await db.query("UPDATE clients SET credentials_enc = $1 WHERE id = $2", [newEnc, clientId]);

  console.log(`\n✓ PIN added successfully for ${row.name}.`);
  console.log("Updated credentials (masked):");
  console.log(JSON.stringify(mask(updated), null, 2));
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nScript failed:", err.message);
  process.exit(1);
});
