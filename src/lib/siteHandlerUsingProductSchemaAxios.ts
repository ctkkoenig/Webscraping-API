import Proxy, { ProxyRequestOptions } from "./ProxyAxios";
import * as cheerio from "cheerio";
import { Element } from "domhandler";
import cleanText from "./cleanText";
import cleanImageUrl from "./cleanImageUrl";

// Set this to 'true' or 'false' to enable/disable HTML debug logging
const DEBUG_HTML = false;

const siteHandlerUsingProductSchema = async (
  url: URL,
  options: ProxyRequestOptions = { method: "GET" }
) => {
  let html: string | null = null;

  try {
    // Fetch the HTML content
    html = await fetchHtml(url, options);
    if (!html) {
      throw new Error("No HTML returned by fetchHtml");
    }

    // Parse using Cheerio
    const $ = cheerio.load(html);

    // Get the product schema
    const product = getProductSchema($);
    if (!product) throw new Error("Could not find product");

    // Transform product schema into item info
    return getItemInfoFromProductSchema(product, url.origin);
  } catch (error) {
    console.error(
      `Error in siteHandlerUsingProductSchema: ${
        error instanceof Error ? error.message : String(error)
      }`
    );

    // If we managed to fetch HTML and debug is on, log it here
    if (html && DEBUG_HTML) {
      console.error("Full HTML content:\n", html);
    }

    // Rethrow to let higher-level code handle
    throw error;
  }
};

// Helper function to fetch the HTML content
const fetchHtml = async (url: URL, options: ProxyRequestOptions) => {
  const html = await Proxy.shared.fetch(url, options);
  return html;
};

// Helper function to find something in an object/array
const findInMaybeArray = (data: any, predicate: (data: any) => boolean) =>
  (data &&
    (Array.isArray(data) ? data.find(predicate) : predicate(data) && data)) ||
  null;

// Check if an object has a @type of product
const isProduct = (data: any) =>
  ["product", "productgroup"].includes(data["@type"]?.trim().toLowerCase());

// Extract product schema from JSON-LD scripts
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

// Convert the product schema into your final return object
const getItemInfoFromProductSchema = (
  product: Record<string, any>,
  origin: string
): {
  name: string;
  image: string | null;
  price: number;
  available: boolean;
} => {
  const name = cleanText(product.name || "") as string | null;
  if (!name) throw new Error("Missing name");

  const _image = (findInMaybeArray(product.image, () => true)?.trim() ||
    null) as string | null;
  const image = _image && cleanImageUrl(_image, origin);

  const offer = findInMaybeArray(product.offers, isOffer);
  if (!offer) throw new Error("Could not find product offer");

  const currency = offer.priceCurrency?.trim().toLowerCase();
  if (currency && currency !== "usd") {
    throw new Error("Item price is not in USD");
  }

  // ADD ANOTHER FALLBACK FOR 'priceSpecification' IF NO PRICE IS FOUND
  const rawPrice =
    offer.lowPrice ??
    offer.minPrice ??
    offer.price ??
    (Array.isArray(offer.priceSpecification)
      ? offer.priceSpecification[0]?.price
      : undefined);

  const price =
    typeof rawPrice === "number"
      ? rawPrice
      : typeof rawPrice === "string"
      ? parseFloat(rawPrice.trim())
      : NaN;

  if (isNaN(price) || price < 0) {
    throw new Error("Invalid price");
  }

  const availability = offer.availability
    ?.trim()
    .toLowerCase()
    .endsWith("/instock");

  if (typeof availability !== "boolean") {
    throw new Error("Invalid availability");
  }

  return { name, image, price, available: availability };
};

export default siteHandlerUsingProductSchema;
