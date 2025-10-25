#!/usr/bin/env node
/**
 * UMG JSON → PSD MCP Server
 * - Tool: umg.pipeline
 * - Step1: Ensure Image assets (generate placeholders if missing)
 * - Step2: Compose PSD from updated JSON
 * - DEV mode: run pipeline directly without MCP
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, registerFont } from "canvas";
import { writePsd } from "ag-psd";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const writeJson = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2));
const n = (v, d = 0) => (typeof v === "number" ? v : d);

const rr = (ctx, x, y, w, h, r) => {
  const rad = Math.max(0, Math.min(Number(r || 0), Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
};

async function genPlaceholderPNG({
  outPath, width, height, style = "gradient",
  solidColor = "#666666", label = { show: true, text: "Image" }, borderRadius = 12
}) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");

  if (style === "checker") {
    for (let y = 0; y < h; y += 20) for (let x = 0; x < w; x += 20) {
      ctx.fillStyle = ((x + y) / 20) % 2 === 0 ? "#bdbdbd" : "#e0e0e0";
      ctx.fillRect(x, y, 20, 20);
    }
  } else if (style === "solid") {
    ctx.fillStyle = solidColor; ctx.fillRect(0, 0, w, h);
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#2b2b2b"); g.addColorStop(1, "#515151");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  if (borderRadius > 0) { ctx.save(); rr(ctx, 0, 0, w, h, borderRadius); ctx.clip(); }

  ctx.globalAlpha = 0.15;
  for (let i = -h; i < w; i += 24) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h);
    ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  if (label?.show) {
    ctx.fillStyle = "rgba(0,0,0,.5)";
    ctx.fillRect(0, h / 2 - 22, w, 44);
    ctx.fillStyle = "#ffffff";
    const px = Math.max(14, Math.floor(Math.min(w, h) * 0.12));
    ctx.font = `bold ${px}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label?.text || "Image", w / 2, h / 2);
  }

  if (borderRadius > 0) ctx.restore();
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, c.toBuffer("image/png"));
  return outPath;
}

const isHttp = (value) => typeof value === "string" && /^https?:\/\//i.test(value);
const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const sanitizeFilename = (value, fallback) =>
  (value || fallback || "asset")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || (fallback || "asset");

const alignMap = {
  left: "left",
  center: "center",
  middle: "center",
  right: "right",
  justify: "center",
};

const verticalAlignMap = {
  top: "top",
  middle: "middle",
  center: "middle",
  bottom: "bottom",
};

const weightMap = {
  thin: "100",
  extralight: "200",
  ultralight: "200",
  light: "300",
  regular: "400",
  normal: "400",
  medium: "500",
  semibold: "600",
  demibold: "600",
  bold: "700",
  extrabold: "800",
  ultrabold: "800",
  black: "900",
  heavy: "900",
};

const defaultFontFamily = "Arial";
const defaultBorderBackground = "#1A1A1A";
const defaultBorderStroke = "#333333";

async function downloadToFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  return destPath;
}

function copyLocalFile(src, dest) {
  ensureDir(path.dirname(dest));
  if (path.resolve(src) === path.resolve(dest)) return dest;
  fs.copyFileSync(src, dest);
  return dest;
}

function computeBounds(elements, margin = 64) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasGeometry = false;

  for (const element of elements || []) {
    const x = n(element?.position?.x, 0);
    const y = n(element?.position?.y, 0);
    const w = n(element?.size?.width, 0);
    const h = n(element?.size?.height, 0);

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    hasGeometry = true;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  if (!hasGeometry) {
    minX = 0;
    minY = 0;
    maxX = 1024;
    maxY = 768;
  }

  const width = Math.max(1, Math.ceil(maxX - minX) + margin * 2);
  const height = Math.max(1, Math.ceil(maxY - minY) + margin * 2);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    margin,
    offsetX: margin - minX,
    offsetY: margin - minY,
  };
}

async function ensureImageAssets(elements, {
  jsonDir,
  assetsDir,
  placeholderStyle = "gradient",
  placeholderLabel,
}) {
  ensureDir(assetsDir);
  const placeholderDir = path.join(assetsDir, "placeholders");
  ensureDir(placeholderDir);

  const cloned = JSON.parse(JSON.stringify(elements || []));
  const generated = [];

  for (let idx = 0; idx < cloned.length; idx += 1) {
    const element = cloned[idx];
    if (!element || typeof element !== "object") continue;
    if (!/^image$/i.test(element.type || "")) continue;

    const width = Math.max(1, Math.round(n(element?.size?.width, 256)));
    const height = Math.max(1, Math.round(n(element?.size?.height, 256)));
    const currentSource = (element.image_source || element.imageSource || "").toString().trim();

    let finalSource = currentSource;
    let needsPlaceholder = !finalSource;

    if (!needsPlaceholder && !isHttp(finalSource)) {
      const abs = path.resolve(jsonDir, finalSource);
      if (!fs.existsSync(abs)) {
        needsPlaceholder = true;
      }
    }

    if (needsPlaceholder) {
      const name = sanitizeFilename(element.name, `image-${idx + 1}`);
      const placeholderPath = path.join(placeholderDir, `${name}.png`);
      await genPlaceholderPNG({
        outPath: placeholderPath,
        width,
        height,
        style: placeholderStyle,
        label: {
          show: true,
          text: placeholderLabel || element.name || "Image",
        },
        borderRadius: n(element.border_radius, n(element.corner_radius, 0)),
      });

      finalSource = path.relative(jsonDir, placeholderPath).replace(/\\/g, "/");
      generated.push({
        element: element.name || `Image${idx + 1}`,
        placeholderPath,
      });
    }

    element.image_source = finalSource;
    element.imageSource = finalSource;

    // Auto-populate missing size using actual image when possible.
    const sourceForProbe = finalSource;
    const absolute = isHttp(sourceForProbe)
      ? sourceForProbe
      : path.resolve(jsonDir, sourceForProbe);

    try {
      const img = await loadImage(absolute);
      if (img) {
        element.size = element.size || {};
        if (!element.size.width) element.size.width = img.width;
        if (!element.size.height) element.size.height = img.height;
      }
    } catch (err) {
      console.warn(`⚠️  Unable to load image for element "${element.name || element.type}": ${err.message}`);
    }
  }

  return { elements: cloned, placeholders: generated };
}

function resolveOutputJsonPath({ imagePath, outputJsonPath }) {
  if (outputJsonPath) return path.resolve(outputJsonPath);

  const parsed = (() => {
    if (isHttp(imagePath)) {
      try {
        const url = new URL(imagePath);
        return path.parse(url.pathname);
      } catch (_err) {
        return { name: "layout", ext: ".json" };
      }
    }
    return path.parse(path.resolve(imagePath));
  })();

  const dir = isHttp(imagePath) ? process.cwd() : path.dirname(path.resolve(imagePath));
  const filename = `${sanitizeFilename(parsed.name, "layout")}.json`;
  return path.join(dir, filename);
}

async function prepareImageAssetForJson({
  imagePath,
  assetsDir,
  jsonDir,
}) {
  const remote = isHttp(imagePath);
  let sourceForLoad = imagePath;
  let finalImageReference = imagePath;
  let copiedAssetPath = null;

  if (!remote) {
    const resolved = path.resolve(imagePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Image file not found: ${resolved}`);
    }
    sourceForLoad = resolved;
  }

  if (assetsDir) {
    const parsedName = (() => {
      if (remote) {
        try {
          const url = new URL(imagePath);
          return path.parse(url.pathname);
        } catch (_err) {
          return { name: "image", ext: "" };
        }
      }
      return path.parse(path.resolve(imagePath));
    })();

    const safeName = sanitizeFilename(parsedName.name, "image");
    const extension = parsedName.ext || ".png";
    const destPath = path.join(path.resolve(assetsDir), `${safeName}${extension}`);

    if (remote) {
      await downloadToFile(imagePath, destPath);
    } else {
      copyLocalFile(sourceForLoad, destPath);
    }

    copiedAssetPath = destPath;
    sourceForLoad = destPath;
    finalImageReference = path.relative(jsonDir, destPath).replace(/\\/g, "/");
  } else if (!remote) {
    finalImageReference = path.relative(jsonDir, path.resolve(imagePath)).replace(/\\/g, "/");
  }

  return {
    sourceForLoad,
    finalImageReference,
    copiedAssetPath,
  };
}

async function generateJsonFromImage({
  imagePath,
  outputJsonPath,
  assetsDir,
  includeBorder = true,
  margin = 24,
  position = { x: 0, y: 0 },
  borderRadius = 0,
  backgroundColor = defaultBorderBackground,
  borderColor = defaultBorderStroke,
  containerName,
  imageName,
}) {
  if (!imagePath) {
    throw new Error("imagePath is required to generate JSON");
  }

  const resolvedJsonPath = resolveOutputJsonPath({ imagePath, outputJsonPath });
  ensureDir(path.dirname(resolvedJsonPath));

  const jsonDir = path.dirname(resolvedJsonPath);
  const assetPreparation = await prepareImageAssetForJson({
    imagePath,
    assetsDir,
    jsonDir,
  });

  const image = await loadImage(assetPreparation.sourceForLoad);
  const width = Math.max(1, Math.round(image.width));
  const height = Math.max(1, Math.round(image.height));

  const parsedForNaming = (() => {
    if (imageName) return { name: imageName };
    if (isHttp(imagePath)) {
      try {
        const remoteParsed = path.parse(new URL(imagePath).pathname);
        return remoteParsed.name ? remoteParsed : { name: "image" };
      } catch (_err) {
        return { name: "image" };
      }
    }
    return path.parse(path.resolve(imagePath));
  })();

  const safeImageName = imageName || sanitizeFilename(parsedForNaming.name, "image");
  const safeContainerName = containerName || `${safeImageName}-container`;

  const marginValue = Math.max(0, Math.round(margin ?? 0));
  const posX = Math.round(n(position?.x, 0));
  const posY = Math.round(n(position?.y, 0));

  const elements = [];
  if (includeBorder) {
    elements.push({
      type: "Border",
      name: safeContainerName,
      position: { x: posX, y: posY },
      size: {
        width: width + marginValue * 2,
        height: height + marginValue * 2,
      },
      color: {
        background: backgroundColor,
        border: borderColor,
      },
      border_radius: borderRadius,
      z_order: 0,
      children: [safeImageName],
    });
  }

  elements.push({
    type: "Image",
    name: safeImageName,
    position: {
      x: posX + (includeBorder ? marginValue : 0),
      y: posY + (includeBorder ? marginValue : 0),
    },
    size: { width, height },
    image_source: assetPreparation.finalImageReference,
    imageSource: assetPreparation.finalImageReference,
    z_order: includeBorder ? 1 : 0,
  });

  writeJson(resolvedJsonPath, elements);

  return {
    jsonPath: resolvedJsonPath,
    width,
    height,
    elements: elements.length,
    includeBorder,
    imageReference: assetPreparation.finalImageReference,
    copiedAssetPath: assetPreparation.copiedAssetPath,
  };
}

function buildLayerFrame(element, offsetX, offsetY) {
  const type = (element?.type || "").toString().toLowerCase();
  const textLength = ((element?.content ?? element?.text ?? "").toString() || "").length;
  const fontSize = Math.max(1, Math.round(n(element?.font?.size, 24)));

  let fallbackWidth = 256;
  let fallbackHeight = 256;

  if (type === "text" || type === "textblock" || type === "richtextblock") {
    fallbackWidth = Math.max(128, Math.min(1400, textLength * Math.max(12, Math.round(fontSize * 0.6))));
    fallbackHeight = Math.max(48, Math.round(fontSize * 1.6));
  } else if (type === "image" || type === "texture" || type === "brush") {
    fallbackWidth = Math.max(128, Math.round(n(element?.preferred_width, 256)));
    fallbackHeight = Math.max(128, Math.round(n(element?.preferred_height, 256)));
  }

  const width = Math.max(1, Math.round(n(element?.size?.width, fallbackWidth)));
  const height = Math.max(1, Math.round(n(element?.size?.height, fallbackHeight)));
  if (width <= 0 || height <= 0) return null;

  const left = Math.round(n(element?.position?.x, 0) + offsetX);
  const top = Math.round(n(element?.position?.y, 0) + offsetY);

  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

function renderBorderLayer(element, frame) {
  const radius = n(element.border_radius, n(element.corner_radius, 0));
  const strokeWidth = n(element.border_width, n(element.stroke_width, 0));
  const background = element.color?.background || element.background || null;
  const borderColor = element.color?.border || element.border_color || null;

  const canvas = createCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");

  if (background) {
    ctx.save();
    if (radius > 0) {
      rr(ctx, 0, 0, frame.width, frame.height, radius);
      ctx.clip();
    }
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, frame.width, frame.height);
    if (radius > 0) ctx.restore();
  }

  if (borderColor && strokeWidth > 0) {
    ctx.save();
    rr(ctx, strokeWidth / 2, strokeWidth / 2, frame.width - strokeWidth, frame.height - strokeWidth, Math.max(0, radius - strokeWidth / 2));
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = borderColor;
    ctx.stroke();
    ctx.restore();
  }

  return {
    name: element.name || element.type || "Border",
    canvas,
    top: frame.top,
    left: frame.left,
    right: frame.right,
    bottom: frame.bottom,
    opacity: Math.round(Math.min(1, Math.max(0, n(element.opacity, 1))) * 255),
  };
}

async function renderImageLayer(element, frame, baseDir) {
  const source = element.image_source || element.imageSource;
  if (!source) return null;

  const absolute = isHttp(source) ? source : path.resolve(baseDir, source);
  let image;
  try {
    image = await loadImage(absolute);
  } catch (err) {
    console.warn(`⚠️  Failed to load image "${source}": ${err.message}`);
    return null;
  }

  const canvas = createCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  const radius = n(element.border_radius, n(element.corner_radius, 0));

  if (radius > 0) {
    ctx.save();
    rr(ctx, 0, 0, frame.width, frame.height, radius);
    ctx.clip();
  }

  ctx.drawImage(image, 0, 0, frame.width, frame.height);

  if (radius > 0) ctx.restore();

  if (element.color?.border && n(element.border_width, 0) > 0) {
    const stroke = n(element.border_width, 1);
    ctx.save();
    rr(ctx, stroke / 2, stroke / 2, frame.width - stroke, frame.height - stroke, Math.max(0, radius - stroke / 2));
    ctx.lineWidth = stroke;
    ctx.strokeStyle = element.color.border;
    ctx.stroke();
    ctx.restore();
  }

  return {
    name: element.name || element.type || "Image",
    canvas,
    top: frame.top,
    left: frame.left,
    right: frame.right,
    bottom: frame.bottom,
    opacity: Math.round(Math.min(1, Math.max(0, n(element.opacity, 1))) * 255),
  };
}

function registerFontIfProvided(font) {
  if (!font) return;
  const paths = toArray(font.paths || font.path || font.file);
  for (const fontPath of paths) {
    if (!fontPath) continue;
    const abs = path.resolve(fontPath);
    if (!fs.existsSync(abs)) continue;
    const family = font.family || defaultFontFamily;
    try {
      registerFont(abs, { family });
    } catch (err) {
      console.warn(`⚠️  Failed to register font ${abs}: ${err.message}`);
    }
  }
}

function drawTextContent(ctx, element, width, height) {
  const text = (element.content ?? element.text ?? "").toString();
  if (!text) return false;

  const font = element.font || {};
  registerFontIfProvided(font);

  const size = Math.max(1, Math.round(n(font.size, 24)));
  const weightKey = (font.weight || "normal").toString().toLowerCase();
  const weight = weightMap[weightKey] || weightKey || "400";
  const style = (font.style || "normal").toString().toLowerCase();
  const family = font.family || defaultFontFamily;

  const fontParts = [];
  if (style && style !== "normal") fontParts.push(style);
  if (weight) fontParts.push(weight);
  fontParts.push(`${size}px`);
  fontParts.push(family.includes(" ") ? `"${family}"` : family);
  ctx.font = fontParts.join(" ");

  const alignKey = (font.alignment || font.justification || "center").toString().toLowerCase();
  const textAlign = alignMap[alignKey] || "center";
  ctx.textAlign = textAlign;

  const vAlignKey = (font.vertical_alignment || font.verticalAlignment || "middle").toString().toLowerCase();
  const verticalAlign = verticalAlignMap[vAlignKey] || "middle";

  ctx.fillStyle = element.color?.text || font.color || "#ffffff";
  ctx.textBaseline = "middle";

  const lines = text.split(/\r?\n/);
  const lineHeight = Math.max(size, Math.round(n(font.line_height, size * 1.25)));
  const totalHeight = lineHeight * lines.length;

  let startY = height / 2;
  if (verticalAlign === "top") startY = lineHeight / 2;
  else if (verticalAlign === "bottom") startY = height - totalHeight + lineHeight / 2;

  const xPos = textAlign === "left" ? 4 : textAlign === "right" ? width - 4 : width / 2;

  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    ctx.fillText(line, xPos, y);
  });

  return true;
}

function renderTextLayer(element, frame) {
  const text = (element.content ?? element.text ?? "").toString();
  if (!text) return null;

  const canvas = createCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");

  const drawn = drawTextContent(ctx, element, frame.width, frame.height);
  if (!drawn) return null;

  return {
    name: element.name || element.type || "Text",
    canvas,
    top: frame.top,
    left: frame.left,
    right: frame.right,
    bottom: frame.bottom,
    opacity: Math.round(Math.min(1, Math.max(0, n(element.opacity, 1))) * 255),
  };
}

async function renderElement(element, context) {
  const frame = buildLayerFrame(element, context.offsetX, context.offsetY);
  if (!frame) return null;

  const type = (element.type || "").toString().toLowerCase();

  if (type === "border" || type === "panel" || type === "rectangle" || type === "box") {
    return renderBorderLayer(element, frame);
  }

  if (type === "text" || type === "textblock" || type === "richtextblock") {
    return renderTextLayer(element, frame);
  }

  if (type === "button" || type === "editabletextbox" || type === "textbox" || type === "input" || type === "textfield" || type === "textarea") {
    const baseLayer = renderBorderLayer(element, frame);
    if (baseLayer) {
      const ctx = baseLayer.canvas.getContext("2d");
      drawTextContent(ctx, element, frame.width, frame.height);
      return baseLayer;
    }

    return renderTextLayer(element, frame);
  }

  if (type === "image" || type === "texture" || type === "brush") {
    return renderImageLayer(element, frame, context.baseDir);
  }

  // Default fallback: render as filled rectangle for visibility.
  return renderBorderLayer(element, frame);
}

async function composePsd(elements, options) {
  const bounds = computeBounds(elements, options.margin);
  const context = {
    offsetX: bounds.offsetX,
    offsetY: bounds.offsetY,
    baseDir: options.baseDir,
  };

  const sortedElements = (elements || [])
    .map((element, index) => ({ element, index }))
    .sort((a, b) => {
      const aZ = n(a.element?.z_order, n(a.element?.zOrder, 0));
      const bZ = n(b.element?.z_order, n(b.element?.zOrder, 0));
      if (aZ !== bZ) return aZ - bZ;
      return a.index - b.index;
    })
    .map((entry) => entry.element);

  const layers = [];
  for (const element of sortedElements) {
    const layer = await renderElement(element, context);
    if (layer) layers.push(layer);
  }

  const psd = {
    width: bounds.width,
    height: bounds.height,
    children: layers.reverse(),
  };

  return { psd, bounds, layerCount: layers.length };
}

async function runPipeline({
  jsonPath,
  outputDir,
  assetsDir,
  placeholderStyle = "gradient",
  placeholderLabel,
  overwriteJson = false,
  psdFilename,
  margin = 64,
}) {
  if (!jsonPath) throw new Error("jsonPath is required");
  const resolvedJson = path.resolve(jsonPath);
  if (!fs.existsSync(resolvedJson)) {
    throw new Error(`Input JSON not found: ${resolvedJson}`);
  }

  const jsonDir = path.dirname(resolvedJson);
  const payload = readJson(resolvedJson);
  if (!Array.isArray(payload)) {
    throw new Error("Expected the UMG JSON to be an array of elements");
  }

  const resolvedOutputDir = path.resolve(outputDir || path.join(jsonDir, "dist"));
  const resolvedAssetsDir = path.resolve(assetsDir || path.join(resolvedOutputDir, "assets"));
  ensureDir(resolvedOutputDir);
  ensureDir(resolvedAssetsDir);

  const { elements, placeholders } = await ensureImageAssets(payload, {
    jsonDir,
    assetsDir: resolvedAssetsDir,
    placeholderStyle,
    placeholderLabel,
  });

  const updatedJsonPath = overwriteJson
    ? resolvedJson
    : path.join(resolvedOutputDir, path.basename(resolvedJson));

  if (!overwriteJson) {
    ensureDir(path.dirname(updatedJsonPath));
  }

  writeJson(updatedJsonPath, elements);

  const { psd, bounds, layerCount } = await composePsd(elements, {
    margin,
    baseDir: jsonDir,
  });

  const finalPsdName = psdFilename || `${path.parse(resolvedJson).name}.psd`;
  const psdPath = path.join(resolvedOutputDir, finalPsdName);

  const buffer = writePsd(psd);
  fs.writeFileSync(psdPath, Buffer.from(buffer));

  return {
    updatedJsonPath,
    psdPath,
    layerCount,
    bounds,
    placeholders,
  };
}

async function startMcpServer() {
  const instructions = [
    "1. Generate layout JSONs from images via umg.imageToJson (optional).",
    "2. For existing layouts, call umg.pipeline with json_path and desired overrides.",
    "3. The pipeline ensures missing assets, updates JSON, and writes a layered PSD.",
  ].join("\n");

  const mcp = new McpServer(
    {
      name: "umg-json-to-psd",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
      instructions,
    }
  );

  const pipelineInputShape = {
    json_path: z
      .string()
      .min(1, "json_path is required")
      .describe("Absolute path to the UMG JSON layout"),
    output_dir: z
      .string()
      .min(1)
      .describe("Directory where PSD/JSON outputs will be written")
      .optional(),
    assets_dir: z
      .string()
      .min(1)
      .describe("Directory to store ensured image assets and placeholders")
      .optional(),
    placeholder_style: z
      .enum(["gradient", "solid", "checker"])
      .describe("Visual style for generated placeholders")
      .optional(),
    placeholder_label: z
      .string()
      .min(1)
      .describe("Override label text drawn onto placeholders")
      .optional(),
    overwrite_json: z
      .boolean()
      .describe("Write ensured asset paths back into the source JSON")
      .optional(),
    psd_filename: z
      .string()
      .min(1)
      .describe("Filename to use for the generated PSD")
      .optional(),
    margin: z
      .number()
      .min(0)
      .max(4096)
      .describe("Canvas padding (pixels) added around layout bounds")
      .optional(),
  };

  const imageToJsonInputShape = {
    image_path: z
      .string()
      .min(1, "image_path is required")
      .describe("Image URL or local file path to analyse"),
    output_json: z
      .string()
      .min(1)
      .describe("Optional explicit path for the generated JSON file")
      .optional(),
    assets_dir: z
      .string()
      .min(1)
      .describe("Directory where the source image should be copied or downloaded")
      .optional(),
    include_border: z
      .boolean()
      .describe("Wrap the image in a Border element with padding/background")
      .optional(),
    margin: z
      .number()
      .min(0)
      .max(4096)
      .describe("Padding (pixels) applied inside the border")
      .optional(),
    border_radius: z
      .number()
      .min(0)
      .max(1024)
      .describe("Corner radius to apply to the border element")
      .optional(),
    background_color: z
      .string()
      .min(1)
      .describe("Background colour for the generated border element")
      .optional(),
    border_color: z
      .string()
      .min(1)
      .describe("Stroke colour for the generated border element")
      .optional(),
    position_x: z
      .number()
      .describe("Horizontal position for the generated elements")
      .optional(),
    position_y: z
      .number()
      .describe("Vertical position for the generated elements")
      .optional(),
    container_name: z
      .string()
      .min(1)
      .describe("Name override for the generated container element")
      .optional(),
    image_name: z
      .string()
      .min(1)
      .describe("Name override for the generated image element")
      .optional(),
  };

  const pipelineOutputShape = {
    updatedJsonPath: z.string(),
    psdPath: z.string(),
    layerCount: z.number(),
    bounds: z.object({
      minX: z.number(),
      minY: z.number(),
      maxX: z.number(),
      maxY: z.number(),
      width: z.number(),
      height: z.number(),
      margin: z.number(),
      offsetX: z.number(),
      offsetY: z.number(),
    }),
    placeholders: z.array(
      z.object({
        element: z.string(),
        placeholderPath: z.string(),
      })
    ),
  };

  const imageToJsonOutputShape = {
    jsonPath: z.string(),
    width: z.number(),
    height: z.number(),
    elements: z.number(),
    includeBorder: z.boolean(),
    imageReference: z.string(),
    copiedAssetPath: z.string().nullable().optional(),
  };

  mcp.registerTool(
    "umg.imageToJson",
    {
      title: "Image → UMG JSON",
      description: "Creates a simple UMG layout JSON from a source image, optionally copying assets.",
      inputSchema: imageToJsonInputShape,
      outputSchema: imageToJsonOutputShape,
    },
    async (args) => {
      const result = await generateJsonFromImage({
        imagePath: args.image_path,
        outputJsonPath: args.output_json,
        assetsDir: args.assets_dir,
        includeBorder: args.include_border ?? true,
        margin: args.margin,
        borderRadius: args.border_radius,
        backgroundColor: args.background_color ?? defaultBorderBackground,
        borderColor: args.border_color ?? defaultBorderStroke,
        position: { x: args.position_x, y: args.position_y },
        containerName: args.container_name,
        imageName: args.image_name,
      });

      const summary = [
        `Generated JSON: ${result.jsonPath}`,
        `Image reference: ${result.imageReference}`,
        `Dimensions: ${result.width}x${result.height}`,
        result.includeBorder ? "Border included" : "Border omitted",
      ];
      if (result.copiedAssetPath) {
        summary.push(`Copied asset: ${result.copiedAssetPath}`);
      }

      return {
        content: [
          {
            type: "text",
            text: summary.join("\n"),
          },
        ],
        structuredContent: result,
      };
    }
  );

  mcp.registerTool(
    "umg.pipeline",
    {
      title: "UMG JSON → PSD",
      description: "Ensures missing image assets and composes a layered PSD from a UMG layout JSON.",
      inputSchema: pipelineInputShape,
      outputSchema: pipelineOutputShape,
    },
    async (args) => {
      const result = await runPipeline({
        jsonPath: args.json_path,
        outputDir: args.output_dir,
        assetsDir: args.assets_dir,
        placeholderStyle: args.placeholder_style,
        placeholderLabel: args.placeholder_label,
        overwriteJson: args.overwrite_json,
        psdFilename: args.psd_filename,
        margin: args.margin,
      });

      const summaryLines = [
        `PSD created: ${result.psdPath}`,
        `Updated JSON: ${result.updatedJsonPath}`,
        `Layers: ${result.layerCount}`,
      ];
      if (result.placeholders?.length) {
        summaryLines.push(`Placeholders generated: ${result.placeholders.length}`);
      } else {
        summaryLines.push("No placeholders were generated.");
      }

      return {
        content: [
          {
            type: "text",
            text: summaryLines.join("\n"),
          },
        ],
        structuredContent: result,
      };
    }
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

async function runDevMode(options) {
  const result = await runPipeline(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

async function runImageMode(options) {
  const result = await generateJsonFromImage(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .scriptName("umg-mcp")
    .option("mode", {
      choices: ["mcp", "dev", "image"],
      default: "mcp",
      describe: "Run as MCP server or execute pipeline directly",
    })
    .option("json", {
      type: "string",
      describe: "Path to the UMG JSON layout",
    })
    .option("out", {
      type: "string",
      describe: "Output directory for PSD/JSON",
    })
    .option("assets", {
      type: "string",
      describe: "Directory for generated assets/placeholders",
    })
    .option("placeholder-style", {
      choices: ["gradient", "solid", "checker"],
      default: "gradient",
      describe: "Style used for placeholder images",
    })
    .option("placeholder-label", {
      type: "string",
      describe: "Optional label text drawn on placeholders",
    })
    .option("overwrite-json", {
      type: "boolean",
      default: false,
      describe: "Write ensured asset paths back into the source JSON",
    })
    .option("psd-name", {
      type: "string",
      describe: "Override PSD filename",
    })
    .option("margin", {
      type: "number",
      describe: "Canvas padding when composing the PSD or generated JSON",
    })
    .option("image", {
      type: "string",
      describe: "Image URL or file path to convert into a layout JSON (image mode)",
    })
    .option("out-json", {
      type: "string",
      describe: "Output JSON path when running in image mode",
    })
    .option("image-assets", {
      type: "string",
      describe: "Directory where the image should be copied/downloaded in image mode",
    })
    .option("include-border", {
      type: "boolean",
      default: true,
      describe: "Include a border element around the generated image in image mode",
    })
    .option("border-radius", {
      type: "number",
      default: 0,
      describe: "Border radius to apply in image mode",
    })
    .option("border-color", {
      type: "string",
      describe: "Border stroke colour override in image mode",
    })
    .option("background-color", {
      type: "string",
      describe: "Border background colour override in image mode",
    })
    .option("x", {
      type: "number",
      describe: "X position for generated elements in image mode",
    })
    .option("y", {
      type: "number",
      describe: "Y position for generated elements in image mode",
    })
    .option("name", {
      type: "string",
      describe: "Container name override in image mode",
    })
    .option("image-name", {
      type: "string",
      describe: "Image element name override in image mode",
    })
    .help()
    .parse();

  if (argv.mode === "dev") {
    if (!argv.json) {
      throw new Error("--json is required in dev mode");
    }

    await runDevMode({
      jsonPath: argv.json,
      outputDir: argv.out,
      assetsDir: argv.assets,
      placeholderStyle: argv.placeholderStyle,
      placeholderLabel: argv.placeholderLabel,
      overwriteJson: argv.overwriteJson,
      psdFilename: argv.psdName,
      margin: argv.margin,
    });
    return;
  }

  if (argv.mode === "image") {
    if (!argv.image) {
      throw new Error("--image is required in image mode");
    }

    await runImageMode({
      imagePath: argv.image,
      outputJsonPath: argv.outJson,
      assetsDir: argv.imageAssets,
      includeBorder: argv.includeBorder,
      margin: argv.margin ?? 24,
      borderRadius: argv.borderRadius,
      backgroundColor: argv.backgroundColor ?? defaultBorderBackground,
      borderColor: argv.borderColor ?? defaultBorderStroke,
      position: { x: argv.x, y: argv.y },
      containerName: argv.name,
      imageName: argv.imageName,
    });
    return;
  }

  await startMcpServer();
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
