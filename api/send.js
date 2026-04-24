import admin from "firebase-admin";

const FIREBASE_MULTICAST_BATCH_SIZE = 500;
const LOCAL_ORIGINS = ["http://localhost:5173"];

// Load from .env
const ENV_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim())
  : [];

// Final allowed origins
export const DEFAULT_ALLOWED_ORIGINS = [
  ...LOCAL_ORIGINS,
  ...ENV_ORIGINS,
];
function getAllowedOrigins() {
  const fromEnv = process.env.ALLOWED_ORIGINS;

  if (!fromEnv) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return fromEnv
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applyCors(req, res) {
  const requestOrigin = req.headers.origin;
  const allowedOrigins = getAllowedOrigins();

  res.setHeader("Access-Control-Allow-Origin", requestOrigin || "*");
  res.setHeader("Vary", "Origin");

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getServiceAccountFromEnv() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.project_id;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || process.env.client_email;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.private_key;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Missing Firebase credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY."
    );
  }

  return {
    projectId,
    clientEmail,
    privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
  };
}

function getMessaging() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccountFromEnv()),
    });
  }

  return admin.messaging();
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function resolveTokens(payload) {
  const tokenList = [];

  if (typeof payload.token === "string" && payload.token.trim()) {
    tokenList.push(payload.token.trim());
  }

  if (Array.isArray(payload.tokens)) {
    for (const currentToken of payload.tokens) {
      if (typeof currentToken === "string" && currentToken.trim()) {
        tokenList.push(currentToken.trim());
      }
    }
  }

  return [...new Set(tokenList)];
}

async function sendBulkNotifications(messaging, tokens, notification) {
  // Firebase allows up to 500 tokens per multicast request.
  // We chunk internally, so there is no total recipient limit for bulk sends.
  const batches = chunkArray(tokens, FIREBASE_MULTICAST_BATCH_SIZE);

  let successCount = 0;
  let failureCount = 0;
  const failed = [];

  for (const batch of batches) {
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification,
    });

    successCount += result.successCount;
    failureCount += result.failureCount;

    result.responses.forEach((response, index) => {
      if (!response.success) {
        failed.push({
          token: batch[index],
          error: response.error?.message || "Unknown error",
        });
      }
    });
  }

  return {
    successCount,
    failureCount,
    failed,
  };
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic security
  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { title, body } = payload;
    const tokens = resolveTokens(payload);

    if (!title || !body || tokens.length === 0) {
      return res.status(400).json({
        error: "Missing fields. Required: title, body, and token or tokens[]",
      });
    }

    const messaging = getMessaging();
    const notification = { title, body };

    if (tokens.length === 1) {
      const response = await messaging.send({
        notification,
        token: tokens[0],
      });

      return res.status(200).json({
        success: true,
        mode: "single",
        token: tokens[0],
        response,
      });
    }

    const result = await sendBulkNotifications(messaging, tokens, notification);

    return res.status(200).json({
      success: result.failureCount === 0,
      mode: "bulk",
      totalTokens: tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount,
      failed: result.failed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}