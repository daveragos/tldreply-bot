import { GoogleGenAI } from '@google/genai';
import { Database } from '../db/database';
import { EncryptionService } from '../utils/encryption';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Pool } from 'pg';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DATABASE_URL = process.env.DATABASE_URL!;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET!;

async function debugModels() {
  if (!DATABASE_URL || !ENCRYPTION_SECRET) {
    console.error('❌ Missing DB or Encryption secrets in .env');
    process.exit(1);
  }

  const db = new Database(DATABASE_URL);
  const encryption = new EncryptionService(ENCRYPTION_SECRET);

  try {
    // Get ALL groups to find one with a key
    // We need to query directly or use a method that returns groups
    // Database class has listGroupsForUser but that needs userId.
    // Let's use raw query if possible, or try to find a public method.
    // getGroup requires chatId.

    // We'll trust that Database.ts has a method or we can add one?
    // Actually, let's just use raw query via the pool if we can access it?
    // Database.pool is private.

    // Let's try to infer a group ID or just use a known one if we saw one in logs?
    // Logs showed group interaction.
    // But better to adding a "getAllGroups" method temporarily or just blindly try a query if we can import Pool?
    // We can't import Pool easily if it's inside `db/database.ts`.

    // Hack: We can extend Database class locally or just copy-paste the query logic?
    // Or just use 'pg' directly here.

    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    });

    const res = await pool.query(
      'SELECT gemini_api_key_encrypted FROM groups WHERE gemini_api_key_encrypted IS NOT NULL LIMIT 1'
    );

    if (res.rows.length === 0) {
      console.log('❌ No configured groups found in DB.');
      process.exit(0);
    }

    const encryptedKey = res.rows[0].gemini_api_key_encrypted;
    console.log('🔐 Found encrypted key.');

    let apiKey = '';
    try {
      const decrypted = encryption.decrypt(encryptedKey);
      // It might be JSON array or string
      try {
        const parsed = JSON.parse(decrypted);
        apiKey = Array.isArray(parsed) ? parsed[0] : decrypted;
      } catch {
        apiKey = decrypted;
      }
    } catch (err) {
      console.error('❌ Failed to decrypt key:', err);
      process.exit(1);
    }

    console.log(`🔑 Using API Key: ${apiKey.substring(0, 8)}...`);

    const genAI = new GoogleGenAI({ apiKey });

    console.log('📋 Listing models (all pages)...');

    // The list() method returns an AsyncIterable in many Google SDKs
    const response = await genAI.models.list();

    // Check if response has models property directly (single page) or is iterable
    console.log('\n✅ Available Models:');

    // Pager iteration
    const foundModels: string[] = [];

    for await (const model of response) {
      console.log(`- ${model.name}`);
      if (model.name) {
        foundModels.push(model.name);
      }
    }

    console.log(`\nTotal models found: ${foundModels.length}`);

    const flashModels = foundModels.filter((n: string) => n.includes('flash'));
    console.log('Flash models found:', flashModels);

    const proModels = foundModels.filter((n: string) => n.includes('pro'));
    console.log('Pro models found:', proModels);

    await pool.end();
  } catch (error: any) {
    console.error('❌ Error:', error);
  }
}

debugModels();
