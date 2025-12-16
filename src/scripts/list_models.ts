import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('❌ No GEMINI_API_KEY found in .env file.');
    console.log('Please make sure you have a .env file with GEMINI_API_KEY=...');
    console.log('Or provide it directly: GEMINI_API_KEY=... npm run list-models');
    process.exit(1);
  }

  console.log('🔄 Connecting to Google GenAI...');
  const genAI = new GoogleGenAI({ apiKey });

  try {
    console.log('📋 Fetching available models...');
    const response: any = await genAI.models.list();

    console.log('\n✅ Available Models:');
    console.log('----------------------------------------');

    const models = response.models || response || [];
    if (models.length === 0) {
      console.log('No models found?');
    }

    for (const model of models) {
      console.log(`- ${model.name}`);
      console.log(`  Display Name: ${model.displayName}`);
      console.log(`  Description: ${model.description}`);
      console.log(`  Supported Methods: ${model.supportedGenerationMethods?.join(', ')}`);
      console.log('----------------------------------------');
    }
  } catch (error: any) {
    console.error('❌ Error listing models:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response, null, 2));
    }
  }
}

listModels();
