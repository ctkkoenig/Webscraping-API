import Proxy from "./ProxyNoStealth";
import * as cheerio from "cheerio";
import { Element } from "domhandler";
import cleanText from "./cleanText";
import cleanImageUrl from "./cleanImageUrl";

const siteHandlerUsingProductSchema = async (url: URL) => {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const product = getProductSchema($);
    if (!product) throw new Error("Could not find product");

    return getItemInfoFromProductSchema(product, url.origin);
  } catch (error) {
    console.error(
      `Error in siteHandlerUsingProductSchema: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
};

// Helper function to fetch the HTML content
const fetchHtml = async (url: URL) => {
  const html = await Proxy.shared.fetch(url, {
    method: "BROWSER",
    waitForNetworkIdle: true,
  });
  return html;
};

// Helper functions
const findInMaybeArray = (data: any, predicate: (data: any) => boolean) =>
  (data &&
    (Array.isArray(data) ? data.find(predicate) : predicate(data) && data)) ||
  null;

const isProduct = (data: any) =>
  ["product", "productgroup"].includes(data["@type"]?.trim().toLowerCase());

const getProductSchema = ($: cheerio.CheerioAPI) => {
  const scripts = $('script[type="application/ld+json"]');

  let product: Record<string, any> | null = null;

  scripts.each((index: number, script: Element) => {
    try {
      const dataString = $(script).html()?.trim();
      if (!dataString) return; // Continue to next script

      const data = JSON.parse(dataString);

      product =
        findInMaybeArray(data, isProduct) ??
        findInMaybeArray(data["@graph"], isProduct);

      if (product) return false; // Break out of the loop
    } catch (error) {
      console.error("Error parsing JSON-LD script:", error);
    }
  });

  return product;
};

const isOffer = (offer: any) =>
  ["aggregateoffer", "offer"].includes(offer["@type"]?.trim().toLowerCase());

const getItemInfoFromProductSchema = (
  product: Record<string, any>,
  origin: string
): {
  name: string;
  image: string | null;
  price: number;
  available: boolean;
} => {
  // Extract and clean the product name
  const name = cleanText(product.name || "") as string | null;
  if (!name) throw new Error("Missing name");

  // Extract and clean the product image URL
  const _image = (findInMaybeArray(product.image, () => true)?.trim() ||
    null) as string | null;
  const image = _image && cleanImageUrl(_image, origin);

  // Find the offer within the product schema
  const offer = findInMaybeArray(product.offers, isOffer);
  if (!offer) throw new Error("Could not find product offer");

  // Validate the currency
  const currency = offer.priceCurrency?.trim().toLowerCase();
  if (currency && currency !== "usd")
    throw new Error("Item price is not in USD");

  // Extract and validate the price
  const rawPrice = offer.lowPrice ?? offer.minPrice ?? offer.price;
  const price =
    typeof rawPrice === "number"
      ? rawPrice
      : typeof rawPrice === "string"
      ? parseFloat(rawPrice.trim())
      : NaN;

  if (isNaN(price) || price < 0) throw new Error("Invalid price");

  // Determine availability
  const availability = offer.availability
    ?.trim()
    .toLowerCase()
    .endsWith("/instock");

  if (typeof availability !== "boolean")
    throw new Error("Invalid availability");

  return { name, image, price, available: availability };
};

export default siteHandlerUsingProductSchema;
