/**
 * Convert markdown to HTML for Telegram
 * According to Telegram Bot API: https://core.telegram.org/bots/api#html-style
 * Supports: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <code>code</code>, <pre>pre</pre>
 */
export function markdownToHtml(text: string): string {
  if (!text) return '';

  let html = text;

  // Step 1: Convert markdown to HTML BEFORE escaping
  // This order is important - we need to convert markdown first, then escape

  // Convert **bold** to <b>bold</b> (non-greedy, handle multiple per line)
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');

  // Convert bullet points: * item or - item (preserve indentation)
  // Process line by line to handle nested bullets correctly
  const lines = html.split('\n');
  const processedLines = lines.map(line => {
    // Check if line starts with bullet (with optional indentation)
    // eslint-disable-next-line no-useless-escape
    const bulletMatch = line.match(/^(\s*)[\*\-]\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      // eslint-disable-next-line prefer-const
      let content = bulletMatch[2];
      // Content may already have <b> tags from previous conversion
      return indent + '• ' + content.trim();
    }
    return line;
  });
  html = processedLines.join('\n');

  // Convert single *italic* to <i>italic</i> (but not **bold** or bullets)
  // Since we already converted **bold** and bullets, remaining * are for italic
  // Match *text* that's not part of ** (already converted) and not at line start
  html = html.replace(/(?<!\*)\*([^*\n<]+?)\*(?!\*)/g, '<i>$1</i>');

  // Convert ~~strikethrough~~ to <s>strikethrough</s>
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Step 2: Escape HTML special characters (but preserve our tags)
  // Escape & first (but not already escaped entities)
  html = html.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;');

  // Escape < and > that are not part of our HTML tags
  // Simple approach: escape all < and >, then restore our tags
  const tagPlaceholders: { [key: string]: string } = {};
  let placeholderIndex = 0;

  // Temporarily replace HTML tags with placeholders
  html = html.replace(/<\/?(?:b|i|u|s|code|pre|a)\b[^>]*>/gi, match => {
    const placeholder = `__TAG_${placeholderIndex++}__`;
    tagPlaceholders[placeholder] = match;
    return placeholder;
  });

  // Now escape remaining < and >
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Restore HTML tags
  for (const [placeholder, tag] of Object.entries(tagPlaceholders)) {
    html = html.replace(placeholder, tag);
  }

  // Clean up excessive spacing
  html = html.replace(/\n{3,}/g, '\n\n');

  return html;
}

/**
 * Split a long message into chunks that fit within Telegram's message length limit
 * Tries to split at paragraph boundaries (double newlines) when possible
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (preferably at paragraph break)
    let splitPoint = maxLength;

    // Look for paragraph break (double newline) near the max length
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paragraphBreak > maxLength * 0.7) {
      // Use paragraph break if it's not too early
      splitPoint = paragraphBreak + 2; // +2 to include \n\n
    } else {
      // Look for single newline
      const lineBreak = remaining.lastIndexOf('\n', maxLength);
      if (lineBreak > maxLength * 0.8) {
        splitPoint = lineBreak + 1; // +1 to include \n
      } else {
        // Look for sentence end
        const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
        if (sentenceEnd > maxLength * 0.7) {
          splitPoint = sentenceEnd + 2; // +2 to include '. '
        } else {
          // Force split at max length
          splitPoint = maxLength;
        }
      }
    }

    // Extract chunk and add continuation indicator if not the last chunk
    const chunk = remaining.substring(0, splitPoint);
    chunks.push(chunk);
    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}
