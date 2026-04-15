const CryptoJS = require("crypto-js");

// Pad or truncate key to exactly 32 characters for AES-256
const RAW_KEY = process.env.ENCRYPTION_KEY || "gridbot_default_32charkey_pad000";
const KEY = RAW_KEY.padEnd(32, "0").slice(0, 32);

function encrypt(obj) {
  const json = JSON.stringify(obj);
  return CryptoJS.AES.encrypt(json, KEY).toString();
}

function decrypt(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, KEY);
  const json  = bytes.toString(CryptoJS.enc.Utf8);
  return JSON.parse(json);
}

// Mask sensitive fields for API responses — never send raw tokens to frontend
function mask(credentials) {
  const masked = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (!v) { masked[k] = ""; continue; }
    if (k === "client_id") { masked[k] = v; continue; } // client_id shown in full
    masked[k] = v.slice(0, 4) + "••••••••" + v.slice(-4); // show first 4 + last 4 only
  }
  return masked;
}

module.exports = { encrypt, decrypt, mask };
