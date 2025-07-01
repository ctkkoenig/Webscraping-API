// src/lib/sites/examplewebsite.com.ts
import Proxy from "../ProxyAxios";
import { load } from "cheerio";

export interface ItemInfo {
  name: string | null;
  image: string | null;
  price: number;
  available: boolean;
}

const getItemInfo_examplewebsite = async (url: URL): Promise<ItemInfo> => {
  // pass both url and options to satisfy Proxy.shared.fetch signature
  const html = await Proxy.shared.fetch(url, { method: "GET" });
  const $ = load(html);

  // name
  const rawName = $("h1.productView-title").first().text().trim();
  const name = rawName || null;

  // image
  const ogImage =
    $('meta[property="og:image"]').attr("content")?.trim() || null;
  const image = ogImage;

  // price
  const priceStr =
    $('meta[property="product:price:amount"]').attr("content")?.trim() || "NaN";
  const price = parseFloat(priceStr);

  // availability
  const avail =
    $('meta[property="og:availability"]').attr("content")?.trim() || "";
  const available = avail.toLowerCase() === "instock";

  return { name, image, price, available };
};

export default getItemInfo_examplewebsite;
