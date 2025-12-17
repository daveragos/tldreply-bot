import { GoogleGenAI } from '@google/genai';
import { logger } from '../utils/logger';

export class GeminiService {
  private keys: string[];
  private currentKeyIndex: number = 0;
  private ais: GoogleGenAI[];
  private exhaustedKeys: Set<number> = new Set();
  private exhaustionTimers: Map<number, NodeJS.Timeout> = new Map();

  constructor(apiKeyOrKeys: string | string[]) {
    if (Array.isArray(apiKeyOrKeys)) {
      this.keys = apiKeyOrKeys;
    } else {
      // Handle potential JSON string if passed directly
      try {
        const parsed = JSON.parse(apiKeyOrKeys);
        if (Array.isArray(parsed)) {
          this.keys = parsed;
        } else {
          this.keys = [apiKeyOrKeys];
        }
      } catch (e) {
        this.keys = [apiKeyOrKeys];
      }
    }

    // Initialize clients for all keys
    this.ais = this.keys.map(key => new GoogleGenAI({ apiKey: key }));
  }

  private getNextAvailableKeyIndex(): number {
    const startIndex = this.currentKeyIndex;
    let attempts = 0;

    while (attempts < this.keys.length) {
      if (!this.exhaustedKeys.has(this.currentKeyIndex)) {
        return this.currentKeyIndex;
      }
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
      attempts++;
    }

    // If all keys are exhausted, just return the current one and hope for the best
    return startIndex;
  }

  private markKeyAsExhausted(index: number) {
    if (this.exhaustedKeys.has(index)) return;

    console.log(`⚠️ Key at index ${index} marked as exhausted (Quota Exceeded)`);
    this.exhaustedKeys.add(index);

    // Reset after 1 minute (Gemini quotas usually reset per minute)
    const timer = setTimeout(() => {
      this.exhaustedKeys.delete(index);
      this.exhaustionTimers.delete(index);
      logger.info(`✅ Key at index ${index} recovered from exhaustion state`);
    }, 60 * 1000);

    this.exhaustionTimers.set(index, timer);
  }

  /**
   * Generates content with automatic model fallback and key rotation
   */
  private async generateContentWithFallback(prompt: string): Promise<string> {
    // Models found available for this key (no 1.5 versions available)
    const models = [
      'gemini-2.0-flash-001',
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite-001',
      'gemini-flash-latest',
      'gemini-2.5-pro',
    ];
    const maxGlobalRetries = 3;
    let lastError: any;

    for (let attempt = 0; attempt < maxGlobalRetries; attempt++) {
      // Rotate key if needed
      const keyIndex = this.getNextAvailableKeyIndex();
      this.currentKeyIndex = keyIndex; // Update pointer
      const currentClient = this.ais[keyIndex];

      // Try models in order
      for (const model of models) {
        try {
          const response = await currentClient.models.generateContent({
            model: model,
            contents: prompt,
          });
          return response.text || 'Generated summary (no text returned)';
        } catch (error: any) {
          lastError = error;
          const errorMessage = error.message || 'Unknown error';

          // Check for quota/rate limits
          if (
            errorMessage.includes('QUOTA_EXCEEDED') ||
            errorMessage.includes('429') ||
            errorMessage.includes('RESOURCE_EXHAUSTED')
          ) {
            this.markKeyAsExhausted(keyIndex);
            logger.warn(`Model ${model} failed with key ${keyIndex}: Quota exceeded.`);

            // Critical Fix:
            // If we have multiple keys and valid ones remain, break to try next key with SAME model (via outer loop).
            // If we are out of keys (or only had one), continue to NEXT MODEL (fallback) with same key (or whatever key we get).
            const hasOtherKeys = this.keys.some((_, i) => !this.exhaustedKeys.has(i));

            if (hasOtherKeys) {
              logger.warn(`Rotating to next available key...`);
              break; // Break model loop -> outer loop retries with next key (starting at models[0])
            } else {
              logger.warn(`No other keys available. Falling back to next model...`);
              continue; // Continue model loop -> try next model (e.g. gemini-1.5) with same key
            }
          }

          // If it's a model not found or server error, try next model with SAME key
          if (
            errorMessage.includes('NOT_FOUND') ||
            errorMessage.includes('503') ||
            errorMessage.includes('500')
          ) {
            logger.warn(`Model ${model} failed: ${errorMessage}. Falling back to next model...`);
            continue; // Try next model
          }

          // If auth error, maybe key is bad?
          if (errorMessage.includes('API_KEY_INVALID')) {
            logger.error(`Invalid key at index ${keyIndex}`);
            break;
          }

          throw error; // Throw other errors immediately
        }
      }

      // Wait before global retry if we haven't succeeded yet
      if (attempt < maxGlobalRetries - 1) {
        // Add simple jitter: 1000ms + random(0-1000ms)
        const delay = 1000 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  async summarizeMessages(
    messages: Array<{
      username?: string;
      firstName?: string;
      content: string;
      timestamp: string;
    }>,
    options?: {
      customPrompt?: string | null;
      summaryStyle?: string;
    },
    retryCount: number = 0
  ): Promise<string> {
    if (messages.length === 0) {
      return 'No messages found in the specified time range.';
    }

    // Use hierarchical summarization for large message sets (>1000 messages)
    const CHUNK_SIZE = 900; // Use 900 to leave room for formatting
    if (messages.length > 1000) {
      return await this.summarizeLargeMessageSet(messages, options, CHUNK_SIZE);
    }

    // For smaller sets, use the base chunk summarization method
    try {
      return await this.summarizeChunk(messages, options);
    } catch (error: any) {
      // Wrap error with better context
      const errorMessage = error.message || 'Unknown error';
      if (
        errorMessage.includes('API_KEY_INVALID') ||
        errorMessage.includes('401') ||
        errorMessage.includes('Unauthorized')
      ) {
        throw new Error(
          "Invalid API key. Please check your Gemini API key and ensure it's correct. You can update it using /update_api_key."
        );
      } else if (errorMessage.includes('PERMISSION_DENIED') || errorMessage.includes('403')) {
        throw new Error(
          'Permission denied. Your API key may not have access to the Gemini API. Please check your API key permissions.'
        );
      } else if (
        errorMessage.includes('QUOTA_EXCEEDED') ||
        errorMessage.includes('429') ||
        errorMessage.includes('RESOURCE_EXHAUSTED')
      ) {
        throw new Error(
          'API quota exceeded. All provided API keys have reached their rate limit. Please try again later or add more keys using /update_api_key.'
        );
      } else if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
        throw new Error('Request timeout. The API request took too long. Please try again.');
      } else if (
        errorMessage.includes('network') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND')
      ) {
        throw new Error(
          'Network error. Could not connect to the Gemini API. Please check your internet connection and try again.'
        );
      }
      throw error;
    }
  }

  /**
   * Hierarchical summarization for large message sets
   * Splits messages into chunks, summarizes each chunk, then merges and summarizes again
   */
  private async summarizeLargeMessageSet(
    messages: Array<{
      username?: string;
      firstName?: string;
      content: string;
      timestamp: string;
    }>,
    options?: {
      customPrompt?: string | null;
      summaryStyle?: string;
    },
    chunkSize: number = 900
  ): Promise<string> {
    const totalMessages = messages.length;
    const chunks: Array<typeof messages> = [];

    // Split messages into chunks
    for (let i = 0; i < messages.length; i += chunkSize) {
      chunks.push(messages.slice(i, i + chunkSize));
    }

    logger.info(`📊 Summarizing ${totalMessages} messages in ${chunks.length} chunks...`);

    // Summarize each chunk (use base method to avoid recursion)
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkSummary = await this.summarizeChunk(chunk, options);
      chunkSummaries.push(
        `[Chunk ${i + 1}/${chunks.length} - ${chunk.length} messages]:\n${chunkSummary}`
      );
    }

    // If we have only one chunk summary, return it (shouldn't happen, but safety check)
    if (chunkSummaries.length === 1) {
      return chunkSummaries[0];
    }

    // Merge all chunk summaries and create final summary
    const mergedSummaries = chunkSummaries.join('\n\n---\n\n');

    // Create a prompt to merge summaries
    const styleInstructions = this.getStyleInstructions(options?.summaryStyle || 'default');
    const mergePrompt = `You are a helpful assistant that creates a comprehensive summary from multiple partial summaries of a Telegram group chat.

${styleInstructions}

You have received ${chunks.length} partial summaries covering ${totalMessages} total messages. Please create a unified, coherent summary that:
- Combines all the important information from the partial summaries
- Removes any redundancy or duplication
- Maintains chronological order where relevant
- Highlights the most important topics, decisions, and announcements
- Preserves the key points from each partial summary

CRITICAL: When referring to users in the summary, ALWAYS use their actual username or name exactly as shown in the partial summaries:
    - If a user has a username (shown as @username), use "@username" in the summary exactly as shown - including any underscores that are part of the username (e.g., @user_name)
    - If a user only has a first name (shown without @), use just the first name exactly as shown - including any underscores if present
    - Never use generic terms like "A user", "Another user", "Someone", etc.
    - Do NOT wrap usernames/names in brackets [], or add formatting around them
    - Write usernames/names exactly as they appear: @username (with underscores if part of the username) or FirstName
    - DO NOT use underscores for formatting/emphasis (like _text_ for underlines) - but keep underscores that are part of actual usernames/names

Partial Summaries:
${mergedSummaries}

Unified Summary:`;

    // Summarize the merged summaries
    const result = await this.generateContentWithFallback(mergePrompt);
    return result || `Summary of ${totalMessages} messages (processed in ${chunks.length} chunks)`;
  }

  /**
   * Base summarization method for a single chunk (no hierarchical processing)
   */
  private async summarizeChunk(
    messages: Array<{
      username?: string;
      firstName?: string;
      content: string;
      timestamp: string;
    }>,
    options?: {
      customPrompt?: string | null;
      summaryStyle?: string;
    }
  ): Promise<string> {
    if (messages.length === 0) {
      return 'No messages in this chunk.';
    }

    // Format messages for context
    const formattedMessages = messages
      .map((msg, idx) => {
        // Use @username if available, otherwise use firstName without @
        const user = msg.username ? `@${msg.username}` : msg.firstName || 'Unknown';
        const content = msg.content;
        return `${idx + 1}. ${user}: ${content}`;
      })
      .join('\n\n');

    // Build base prompt
    let prompt = '';

    if (options?.customPrompt) {
      prompt = options.customPrompt.replace('{{messages}}', formattedMessages);
    } else {
      const styleInstructions = this.getStyleInstructions(options?.summaryStyle || 'default');
      prompt = `You are a helpful assistant that summarizes Telegram group chat conversations.
    ${styleInstructions}

    Focus on:
    - Main topics discussed
    - Key decisions or conclusions
    - Important announcements
    - Ongoing questions or unresolved issues
    - Skip greetings, emojis-only messages, and spam

    CRITICAL: When referring to users in the summary, ALWAYS use their actual username or name exactly as shown in the conversation:
    - If a user has a username (shown as @username), use "@username" in the summary exactly as shown - including any underscores that are part of the username (e.g., @user_name)
    - If a user only has a first name (shown without @), use just the first name exactly as shown - including any underscores if present
    - Never use generic terms like "A user", "Another user", "Someone", etc.
    - Do NOT wrap usernames/names in brackets [], or add formatting around them
    - Write usernames/names exactly as they appear: @username (with underscores if part of the username) or FirstName
    - DO NOT use underscores for formatting/emphasis (like _text_ for underlines) - but keep underscores that are part of actual usernames/names

    IMPORTANT: Format your response using markdown:
    - Use **bold** for important topics or section headers
    - Use bullet points (* item) for lists
    - Keep the summary clear and organized
    - DO NOT use underscores for formatting/emphasis (like _text_ for underlines) - but preserve underscores that are part of usernames/names (e.g., @user_name is correct)
    - DO NOT use any underline formatting in the summary

    Conversation:
    ${formattedMessages}

    Summary:`;
    }

    // Call API with fallback for models and keys
    return await this.generateContentWithFallback(prompt);
  }

  private getStyleInstructions(style: string): string {
    switch (style) {
      case 'detailed':
        return 'Provide a detailed, comprehensive summary. Include all important points, context, and nuances. Keep the summary under 500 words.';
      case 'brief':
        return 'Provide a very brief summary. Focus only on the most critical points. Keep the summary under 150 words.';
      case 'bullet':
        return 'Provide a summary using bullet points. Each bullet should be concise and clear. Keep the summary under 300 words.';
      case 'timeline':
        return 'Provide a chronological summary, organizing events and discussions in the order they occurred. Keep the summary under 400 words.';
      default:
        return 'Provide a concise, well-structured summary. Keep the summary under 300 words and use bullet points if helpful.';
    }
  }

  static validateApiKey(apiKey: string): boolean {
    // Basic validation - Gemini API keys typically have this format
    return apiKey.length > 20 && /^[A-Za-z0-9_-]+$/.test(apiKey);
  }
}
