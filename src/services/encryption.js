const CryptoJS = require("crypto-js");

const KEY = process.env.ENCRYPTION_KEY; // must be 32 chars

if (!KEY || KEY.length < 32) {
  console.error("ENCRYPTION_KEY must be at least 32 characters in .env");
}

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
