import { GoogleGenAI } from '@google/genai';

export class GeminiService {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
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
      if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        throw new Error('Invalid API key. Please check your Gemini API key and ensure it\'s correct. You can update it using /update_api_key.');
      } else if (errorMessage.includes('PERMISSION_DENIED') || errorMessage.includes('403')) {
        throw new Error('Permission denied. Your API key may not have access to the Gemini API. Please check your API key permissions.');
      } else if (errorMessage.includes('QUOTA_EXCEEDED') || errorMessage.includes('429')) {
        throw new Error('API quota exceeded. Your Gemini API key has reached its rate limit or quota. Please try again later or check your API usage.');
      } else if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
        throw new Error('Request timeout. The API request took too long. Please try again.');
      } else if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        throw new Error('Network error. Could not connect to the Gemini API. Please check your internet connection and try again.');
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

    console.log(`📊 Summarizing ${totalMessages} messages in ${chunks.length} chunks...`);

    // Summarize each chunk (use base method to avoid recursion)
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkSummary = await this.summarizeChunk(chunk, options);
      chunkSummaries.push(`[Chunk ${i + 1}/${chunks.length} - ${chunk.length} messages]:\n${chunkSummary}`);
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

CRITICAL: When referring to users in the summary, ALWAYS use their actual username or name (as mentioned in the partial summaries) instead of generic terms like "A user", "Another user", "Someone", etc. Use the exact username or name from the conversation.

Partial Summaries:
${mergedSummaries}

Unified Summary:`;

    // Summarize the merged summaries
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.0-flash-001',
        contents: mergePrompt,
      });
      return response.text || `Summary of ${totalMessages} messages (processed in ${chunks.length} chunks)`;
    } catch (error: any) {
      console.error('Error in hierarchical summarization:', error);
      // Fallback: return the merged summaries as-is
      return `Summary of ${totalMessages} messages:\n\n${mergedSummaries}`;
    }
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
    const formattedMessages = messages.map((msg, idx) => {
      const user = msg.username || msg.firstName || 'Unknown';
      const content = msg.content;
      return `${idx + 1}. [${user}]: ${content}`;
    }).join('\n\n');

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
    
    CRITICAL: When referring to users in the summary, ALWAYS use their actual username or name (as shown in square brackets like [username]) instead of generic terms like "A user", "Another user", "Someone", etc. Use the exact username or name from the conversation.
    
    IMPORTANT: Format your response using markdown:
    - Use **bold** for important topics or section headers
    - Use bullet points (* item) for lists
    - Keep the summary clear and organized
    
    Conversation:
    ${formattedMessages}
    
    Summary:`;
    }

    // Call API with retry logic
    const maxRetries = 3;
    const baseDelay = 1000;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: 'gemini-2.0-flash-001',
          contents: prompt,
        });
        return response.text || 'Generated summary (no text returned)';
      } catch (error: any) {
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    
    throw new Error('Failed to generate summary after multiple retries.');
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
