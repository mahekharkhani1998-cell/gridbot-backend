const CryptoJS = require("crypto-js");

const RAW_KEY = process.env.ENCRYPTION_KEY || "gridbot_default_key_32chars_pad0";
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

function mask(credentials) {
  const masked = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (!v) { masked[k] = ""; continue; }
    if (k === "client_id") { masked[k] = v; continue; }
    masked[k] = v.slice(0, 4) + "••••••••" + v.slice(-4);
  }
  return masked;
}

module.exports = { encrypt, decrypt, mask };
