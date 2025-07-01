const cleanImageUrl = (url: string, origin: string): string => {
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${origin}${url}`;
  if (url.startsWith("http://")) return url.replace(/^http:\/\//, "https://");
  if (url.startsWith("https://")) return url;
  return `https://${url}`;
};

export default cleanImageUrl;
