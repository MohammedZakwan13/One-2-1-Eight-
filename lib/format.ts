export const money = (amount: number) => `₹${Math.round(amount).toLocaleString('en-IN')}`;

export const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Splits plain-text CMS copy into paragraphs. Content is rendered as text nodes only (never as HTML). */
export const toParagraphs = (text: string) => text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
