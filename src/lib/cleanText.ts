export const replaceQuotes = (text: string): string =>
  text
    .replaceAll(/[\u2018\u2019\u201A\u201B\u275B\u275C]/g, "'")
    .replaceAll(/[\u201C\u201D\u201E\u201F\u2E42\u275D\u275E]/g, '"');

const cleanText = (text: string): string =>
  replaceQuotes(text.trim().replaceAll(/\s+/g, " ").replaceAll("&amp;amp;", "&"));

export default cleanText;
