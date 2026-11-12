const $ = (selector) => document.querySelector(selector);

const elements = {
  urlForm: $("#urlForm"),
  archiveUrl: $("#archiveUrl"),
  openRemoteButton: $("#openRemoteButton"),
  chooseLocalButton: $("#chooseLocalButton"),
  localFileInput: $("#localFileInput"),
  statusCard: $("#statusCard"),
  statusTitle: $("#statusTitle"),
  statusText: $("#statusText"),
  statusHint: $("#sourceHint"),
  archiveSection: $("#archiveSection"),
  archiveName: $("#archiveName"),
  archiveMeta: $("#archiveMeta"),
  closeArchiveButton: $("#closeArchiveButton"),
  searchInput: $("#searchInput"),
  resultCount: $("#resultCount"),
  fileList: $("#fileList"),
  emptyList: $("#emptyList"),
  previewDialog: $("#previewDialog"),
  previewTitle: $("#previewTitle"),
  previewMeta: $("#previewMeta"),
  previewContent: $("#previewContent"),
  closePreviewButton: $("#closePreviewButton"),
  cancelPreviewButton: $("#cancelPreviewButton"),
  downloadButton: $("#downloadButton"),
  toast: $("#toast"),
  installButton: $("#installButton"),
  privacyStatus: $("#privacyStatus"),
};

const state = {
  archive: null,
  entries: [],
  visibleEntries: [],
  selectedEntry: null,
  selectedData: null,
  objectUrl: null,
  toastTimer: null,
  installPrompt: null,
  busy: false,
};

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 96 * 1024 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 512 * 1024;

class FileRandomAccessSource {
  constructor(file) {
    this.file = file;
    this.size = file.size;
    this.label = file.name;
  }

  async read(start, endInclusive) {
    if (start < 0 || endInclusive < start || endInclusive >= this.size) {
      throw new Error(`读取范围无效：${start}-${endInclusive}`);
    }
    const slice = this.file.slice(start, endInclusive + 1);
    return new Uint8Array(await slice.arrayBuffer());
  }
}

class HttpRangeSource {
  constructor(url) {
    this.url = new URL(url).href;
    this.size = null;
    this.label = this.url;
    this.totalBytesRead = 0;
    this.requestCount = 0;
  }

  async initialize() {
    let headError = null;
    try {
      const response = await fetch(this.url, {
        method: "HEAD",
        cache: "no-store",
      });
      if (response.ok) {
        this.size = parseContentLength(response.headers.get("content-length"));
      } else {
        headError = new Error(`HEAD 请求返回 ${response.status}`);
      }
    } catch (error) {
      headError = error;
    }

    if (!this.size) {
      try {
        const response = await fetch(this.url, {
          headers: { Range: "bytes=0-0" },
          cache: "no-store",
        });
        const contentRange = response.headers.get("content-range");
        this.size = parseTotalFromContentRange(contentRange);
      } catch (error) {
        throw new Error(
          `无法读取远程文件大小。请检查网络、HTTPS、CORS 和 Range 支持。${
            headError?.message ? ` ${headError.message}` : ""
          }`
        );
      }
    }

    if (!this.size) {
      throw new Error("服务器没有返回文件大小，无法进行分段读取。");
    }
    if (this.size <= 0) {
      throw new Error("远程文件大小为 0。");
    }
    return this;
  }

  async read(start, endInclusive) {
    if (!this.size) throw new Error("远程文件尚未初始化");
    if (start < 0 || endInclusive < start || endInclusive >= this.size) {
      throw new Error(`读取范围无效：${start}-${endInclusive}`);
    }

    this.requestCount += 1;
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${endInclusive}` },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`远程读取失败，HTTP ${response.status}。`);
    }
    if (response.status !== 206) {
      throw new Error(
        "服务器没有返回 206 Partial Content。远程 ZIP 需要支持 HTTP Range。"
      );
    }

    const contentRange = response.headers.get("content-range");
    if (contentRange) {
      const range = parseContentRange(contentRange);
      if (range && range.start !== start) {
        throw new Error(
          `服务器返回了错误范围：请求 ${start}，收到 ${range.start}。`
        );
      }
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedLength = endInclusive - start + 1;
    if (bytes.length !== expectedLength) {
      throw new Error(
        `远程数据长度不完整：需要 ${expectedLength} 字节，收到 ${bytes.length} 字节。`
      );
    }
    this.totalBytesRead += bytes.length;
    return bytes;
  }
}

class ZipArchive {
  constructor(source) {
    this.source = source;
    this.entries = [];
    this.comment = "";
    this.endOfCentralDirectory = null;
    this.zip64 = false;
  }

  async open() {
    const eocd = await this.findEndOfCentralDirectory();
    let centralDirectorySize = eocd.centralDirectorySize;
    let centralDirectoryOffset = eocd.centralDirectoryOffset;
    let totalEntries = eocd.totalEntries;

    if (
      eocd.needsZip64 ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff ||
      totalEntries === 0xffff
    ) {
      const zip64 = await this.findZip64EndOfCentralDirectory(eocd);
      centralDirectorySize = zip64.centralDirectorySize;
      centralDirectoryOffset = zip64.centralDirectoryOffset;
      totalEntries = zip64.totalEntries;
      this.zip64 = true;
    }

    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error(
        `ZIP 中央目录过大（${formatBytes(
          centralDirectorySize
        )}），超过了当前 96 MB 的浏览器安全限制。`
      );
    }
    if (
      centralDirectoryOffset < 0 ||
      centralDirectorySize < 0 ||
      centralDirectoryOffset + centralDirectorySize > this.source.size
    ) {
      throw new Error("ZIP 中央目录范围超出文件边界。");
    }

    const centralDirectory = await this.source.read(
      centralDirectoryOffset,
      centralDirectoryOffset + centralDirectorySize - 1
    );
    this.entries = this.parseCentralDirectory(centralDirectory, totalEntries);
    return this;
  }

  async findEndOfCentralDirectory() {
    const maximumComment = 0xffff;
    const minimumRecord = 22;
    const searchLength = Math.min(
      this.source.size,
      minimumRecord + maximumComment
    );
    const start = this.source.size - searchLength;
    const tail = await this.source.read(start, this.source.size - 1);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    for (let index = tail.length - minimumRecord; index >= 0; index -= 1) {
      if (view.getUint32(index, true) !== EOCD_SIGNATURE) continue;
      const commentLength = view.getUint16(index + 20, true);
      if (index + minimumRecord + commentLength > tail.length) continue;

      const diskNumber = view.getUint16(index + 4, true);
      const centralDirectoryDisk = view.getUint16(index + 6, true);
      return {
        absoluteOffset: start + index,
        diskNumber,
        centralDirectoryDisk,
        entriesOnDisk: view.getUint16(index + 8, true),
        totalEntries: view.getUint16(index + 10, true),
        centralDirectorySize: view.getUint32(index + 12, true),
        centralDirectoryOffset: view.getUint32(index + 16, true),
        comment: decodeText(
          tail.subarray(index + minimumRecord, index + minimumRecord + commentLength)
        ),
        needsZip64:
          view.getUint16(index + 8, true) === 0xffff ||
          view.getUint16(index + 10, true) === 0xffff ||
          view.getUint32(index + 12, true) === 0xffffffff ||
          view.getUint32(index + 16, true) === 0xffffffff,
      };
    }

    throw new Error("没有找到 ZIP End of Central Directory；文件可能不是 ZIP。");
  }

  async findZip64EndOfCentralDirectory(eocd) {
    const locatorStart = eocd.absoluteOffset - 20;
    if (locatorStart < 0) {
      throw new Error("ZIP64 定位器缺失。");
    }

    const locator = await this.source.read(locatorStart, eocd.absoluteOffset - 1);
    const locatorView = new DataView(
      locator.buffer,
      locator.byteOffset,
      locator.byteLength
    );
    if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error("ZIP64 End of Central Directory Locator 签名无效。");
    }

    const zip64Offset = readUint64(locatorView, 8);
    const record = await this.source.read(zip64Offset, zip64Offset + 55);
    const recordView = new DataView(
      record.buffer,
      record.byteOffset,
      record.byteLength
    );
    if (recordView.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error("ZIP64 End of Central Directory 签名无效。");
    }

    return {
      totalEntries: readUint64(recordView, 32),
      centralDirectorySize: readUint64(recordView, 40),
      centralDirectoryOffset: readUint64(recordView, 48),
    };
  }

  parseCentralDirectory(bytes, expectedEntries) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];
    let offset = 0;

    while (offset + 46 <= bytes.length) {
      if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const crc32 = view.getUint32(offset + 16, true);
      let compressedSize = view.getUint32(offset + 20, true);
      let uncompressedSize = view.getUint32(offset + 24, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      let localHeaderOffset = view.getUint32(offset + 42, true);
      const fileNameStart = offset + 46;
      const extraStart = fileNameStart + fileNameLength;
      const extraEnd = extraStart + extraLength;
      const commentEnd = extraEnd + commentLength;

      if (commentEnd > bytes.length) {
        throw new Error("ZIP 中央目录条目越过数据边界。");
      }

      const name = decodeZipFileName(
        bytes.subarray(fileNameStart, extraStart),
        Boolean(flags & 0x0800)
      );
      const extra = parseZip64Extra(
        view,
        extraStart,
        extraEnd,
        uncompressedSize,
        compressedSize,
        localHeaderOffset
      );
      uncompressedSize = extra.uncompressedSize;
      compressedSize = extra.compressedSize;
      localHeaderOffset = extra.localHeaderOffset;

      const normalizedName = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
      const directory = normalizedName.endsWith("/");
      const encrypted = Boolean(flags & 0x0001);
      entries.push({
        name: normalizedName.split("/").filter(Boolean).at(-1) || normalizedName,
        path: normalizedName,
        directory,
        encrypted,
        method,
        flags,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        modified: dosDateTimeToDate(
          view.getUint16(offset + 14, true),
          view.getUint16(offset + 12, true)
        ),
        comment: decodeText(bytes.subarray(extraEnd, commentEnd)),
      });

      offset = commentEnd;
    }

    if (offset === 0) {
      throw new Error("ZIP 中央目录为空或签名无效。");
    }
    if (expectedEntries && entries.length !== expectedEntries) {
      console.warn(
        `ZIP 条目数不一致：目录声明 ${expectedEntries}，实际解析 ${entries.length}`
      );
    }
    return entries;
  }

  async readEntry(entry) {
    if (entry.directory) throw new Error("目录不能直接下载。");
    if (entry.encrypted) throw new Error("这个 ZIP 条目已加密。");
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(
        `暂不支持 ZIP 压缩方法 ${entry.method}，当前支持存储和 Deflate。`
      );
    }

    const fixedHeader = await this.source.read(
      entry.localHeaderOffset,
      entry.localHeaderOffset + 29
    );
    const view = new DataView(
      fixedHeader.buffer,
      fixedHeader.byteOffset,
      fixedHeader.byteLength
    );
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new Error("ZIP 局部文件头签名无效。");
    }
    const fileNameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataStart =
      entry.localHeaderOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize - 1;
    if (entry.compressedSize > 0 && dataEnd >= this.source.size) {
      throw new Error("目标文件越过归档边界。");
    }

    const compressed =
      entry.compressedSize === 0
        ? new Uint8Array()
        : await this.source.read(dataStart, dataEnd);
    if (entry.method === 0) {
      if (compressed.length !== entry.uncompressedSize) {
        throw new Error("存储文件的压缩前长度与目录记录不一致。");
      }
      return compressed;
    }
    return inflateRaw(compressed);
  }
}

function parseZip64Extra(
  view,
  start,
  end,
  uncompressedSize,
  compressedSize,
  localHeaderOffset
) {
  let offset = start;
  while (offset + 4 <= end) {
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > end) break;

    if (id === 0x0001) {
      let cursor = dataStart;
      if (uncompressedSize === 0xffffffff && cursor + 8 <= dataEnd) {
        uncompressedSize = readUint64(view, cursor);
        cursor += 8;
      }
      if (compressedSize === 0xffffffff && cursor + 8 <= dataEnd) {
        compressedSize = readUint64(view, cursor);
        cursor += 8;
      }
      if (localHeaderOffset === 0xffffffff && cursor + 8 <= dataEnd) {
        localHeaderOffset = readUint64(view, cursor);
      }
      break;
    }
    offset = dataEnd;
  }

  return { uncompressedSize, compressedSize, localHeaderOffset };
}

function readUint64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("归档中的 64 位偏移超出浏览器安全整数范围。");
  }
  return Number(value);
}

function parseContentLength(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseTotalFromContentRange(value) {
  if (!value) return null;
  const match = value.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function parseContentRange(value) {
  const match = value.match(/bytes\s+(\d+)-(\d+)\/(?:\d+|\*)/i);
  return match
    ? { start: Number(match[1]), end: Number(match[2]) }
    : null;
}

function decodeBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}

function decodeText(bytes) {
  return decodeBytes(bytes);
}

function decodeZipFileName(bytes, utf8) {
  const encodings = utf8 ? ["utf-8"] : ["utf-8", "gb18030", "gbk"];
  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // Try the next encoding.
    }
  }
  return decodeBytes(bytes);
}

function dosDateTimeToDate(dosDate, dosTime) {
  if (!dosDate) return null;
  const year = 1980 + ((dosDate >> 9) & 0x7f);
  const month = ((dosDate >> 5) & 0x0f) - 1;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  return new Date(year, month, day, hour, minute, second);
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 Deflate 解压，请升级系统后重试。");
  }
  try {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("ZIP 解压失败，文件可能损坏或使用了不支持的 Deflate 变体。");
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function extensionOf(path) {
  const name = path.split("/").at(-1) || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileKind(entry) {
  const extension = extensionOf(entry.path);
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"].includes(
      extension
    )
  ) {
    return { className: "image", glyph: "IMG", preview: "image" };
  }
  if (
    [
      "txt",
      "md",
      "json",
      "xml",
      "plist",
      "html",
      "css",
      "js",
      "mjs",
      "ts",
      "swift",
      "m",
      "mm",
      "h",
      "c",
      "cpp",
      "py",
      "sh",
      "yml",
      "yaml",
      "ini",
      "csv",
      "log",
    ].includes(extension)
  ) {
    return { className: "code", glyph: "</>", preview: "text" };
  }
  if (["mp3", "m4a", "wav", "aac", "ogg"].includes(extension)) {
    return { className: "", glyph: "AUD", preview: "audio" };
  }
  if (["mp4", "mov", "m4v", "webm"].includes(extension)) {
    return { className: "", glyph: "VID", preview: "video" };
  }
  if (["zip", "ipa", "tipa", "jar", "apk", "7z", "rar"].includes(extension)) {
    return { className: "archive", glyph: "ZIP", preview: "none" };
  }
  return {
    className: "",
    glyph: extension ? extension.slice(0, 3).toUpperCase() : "FILE",
    preview: "none",
  };
}

function setStatus(title, text, mode = "ready") {
  elements.statusCard.classList.toggle("is-loading", mode === "loading");
  elements.statusCard.classList.toggle("is-error", mode === "error");
  elements.statusCard.classList.toggle("is-active", mode !== "ready");
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  elements.openRemoteButton.disabled = busy;
  elements.chooseLocalButton.disabled = busy;
  elements.openRemoteButton.textContent = busy ? "读取中…" : "打开";
}

function showToast(message, error = false) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", error);
  elements.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(
    () => elements.toast.classList.remove("is-visible"),
    3600
  );
}

function setArchive(archive) {
  state.archive = archive;
  state.entries = archive.entries
    .filter((entry) => !entry.directory)
    .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
  elements.archiveName.textContent = archive.source.label.split("/").at(-1) || "归档";
  const totalSize = state.entries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0
  );
  elements.archiveMeta.textContent = `${state.entries.length} 个文件 · ${formatBytes(
    totalSize
  )} · ${formatBytes(archive.source.size)}${
    archive.zip64 ? " · ZIP64" : ""
  }`;
  elements.archiveSection.hidden = false;
  elements.searchInput.value = "";
  renderFiles();
  window.setTimeout(
    () => elements.archiveSection.scrollIntoView({ behavior: "smooth", block: "start" }),
    80
  );
}

function renderFiles() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase("zh-CN");
  state.visibleEntries = state.entries.filter((entry) =>
    entry.path.toLocaleLowerCase("zh-CN").includes(query)
  );
  elements.resultCount.textContent = `${state.visibleEntries.length} 项`;
  elements.emptyList.hidden = state.visibleEntries.length !== 0;
  elements.fileList.replaceChildren();

  const maximumRows = 1200;
  const fragment = document.createDocumentFragment();
  for (const entry of state.visibleEntries.slice(0, maximumRows)) {
    const kind = fileKind(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-row";
    button.disabled = entry.encrypted;
    button.title = entry.encrypted
      ? "加密条目"
      : "点击读取并预览";
    button.addEventListener("click", () => previewEntry(entry));

    const icon = document.createElement("span");
    icon.className = `file-icon ${kind.className}`.trim();
    icon.textContent = kind.glyph;

    const names = document.createElement("span");
    const fileName = document.createElement("span");
    fileName.className = "file-name";
    fileName.textContent = entry.name;
    const filePath = document.createElement("span");
    filePath.className = "file-path";
    filePath.textContent = entry.encrypted
      ? `${entry.path} · 已加密`
      : entry.path;
    names.append(fileName, filePath);

    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(entry.uncompressedSize);
    button.append(icon, names, size);
    fragment.append(button);
  }
  elements.fileList.append(fragment);

  if (state.visibleEntries.length > maximumRows) {
    const note = document.createElement("div");
    note.className = "empty-list";
    note.innerHTML = `<strong>仅显示前 ${maximumRows} 项</strong><p>使用搜索可以定位其余文件。</p>`;
    elements.fileList.append(note);
  }
}

async function openSource(source) {
  if (state.busy) return;
  setBusy(true);
  setStatus("正在读取归档", "定位 ZIP 目录并解析文件列表…", "loading");
  try {
    if (source instanceof HttpRangeSource) {
      setStatus("正在连接远程文件", "检查 HTTPS、CORS 和字节范围支持…", "loading");
      await source.initialize();
    }
    const archive = new ZipArchive(source);
    await archive.open();
    if (!archive.entries.some((entry) => !entry.directory)) {
      throw new Error("归档中没有可显示的文件。");
    }
    setArchive(archive);
    setStatus(
      "归档已打开",
      `已读取 ${archive.entries.filter((entry) => !entry.directory).length} 个文件。`,
      "ready"
    );
    elements.archiveSection.hidden = false;
    const previewPath = new URLSearchParams(location.search).get("preview");
    if (previewPath) {
      const entry =
        state.entries.find((candidate) => candidate.path === previewPath) ??
        state.entries.find((candidate) => candidate.name === previewPath);
      if (entry) {
        window.setTimeout(() => previewEntry(entry), 180);
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("无法打开归档", error.message, "error");
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function previewEntry(entry) {
  if (!state.archive || state.busy) return;
  setStatus("正在读取文件", entry.path, "loading");
  try {
    const data = await state.archive.readEntry(entry);
    state.selectedEntry = entry;
    state.selectedData = data;
    elements.previewTitle.textContent = entry.name;
    elements.previewMeta.textContent = `${entry.path} · ${formatBytes(
      data.length
    )}`;
    await renderPreview(entry, data);
    if (typeof elements.previewDialog.showModal === "function") {
      elements.previewDialog.showModal();
    } else {
      elements.previewDialog.setAttribute("open", "");
    }
    setStatus(
      "文件已读取",
      `${entry.name} · ${formatBytes(data.length)}`,
      "ready"
    );
  } catch (error) {
    console.error(error);
    setStatus("文件读取失败", error.message, "error");
    showToast(error.message, true);
  }
}

async function renderPreview(entry, data) {
  revokePreviewUrl();
  const kind = fileKind(entry);
  elements.previewContent.replaceChildren();

  if (kind.preview === "image") {
    const type =
      extensionOf(entry.path) === "svg" ? "image/svg+xml" : guessMimeType(entry.path);
    const url = URL.createObjectURL(new Blob([data], { type }));
    state.objectUrl = url;
    const image = document.createElement("img");
    image.alt = entry.name;
    image.src = url;
    image.onerror = () => {
      elements.previewContent.innerHTML =
        '<div class="preview-message">当前系统无法直接显示这种图片格式。<br>你仍然可以保存文件。</div>';
    };
    elements.previewContent.append(image);
    return;
  }

  if (kind.preview === "audio" || kind.preview === "video") {
    const type = guessMimeType(entry.path);
    const url = URL.createObjectURL(new Blob([data], { type }));
    state.objectUrl = url;
    const media = document.createElement(kind.preview);
    media.controls = true;
    media.src = url;
    elements.previewContent.append(media);
    return;
  }

  if (kind.preview === "text") {
    const sample = data.subarray(0, Math.min(data.length, MAX_PREVIEW_TEXT_BYTES));
    const text = decodeBytes(sample);
    const pre = document.createElement("pre");
    pre.textContent =
      text +
      (data.length > sample.length
        ? `\n\n— 仅预览前 ${formatBytes(sample.length)} —`
        : "");
    elements.previewContent.append(pre);
    return;
  }

  const message = document.createElement("div");
  message.className = "preview-message";
  message.innerHTML = `<div><strong>${escapeHtml(
    entry.name
  )}</strong><br><br>这个文件类型没有内置预览。<br>点击“保存文件”导出完整内容。</div>`;
  elements.previewContent.append(message);
}

function guessMimeType(path) {
  const extension = extensionOf(path);
  const types = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    avif: "image/avif",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    aac: "audio/aac",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
    webm: "video/webm",
  };
  return types[extension] || "application/octet-stream";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadSelected() {
  if (!state.selectedEntry || !state.selectedData) return;
  const nativeBridge = window.webkit?.messageHandlers?.exportFile;
  if (nativeBridge && state.selectedData.length <= 32 * 1024 * 1024) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < state.selectedData.length; offset += chunkSize) {
      binary += String.fromCharCode(
        ...state.selectedData.subarray(offset, offset + chunkSize)
      );
    }
    nativeBridge.postMessage({
      name: state.selectedEntry.name || "download",
      mime: guessMimeType(state.selectedEntry.path),
      base64: btoa(binary),
    });
    showToast("已打开系统保存面板。");
    return;
  }

  const blob = new Blob([state.selectedData], {
    type: guessMimeType(state.selectedEntry.path),
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.selectedEntry.name || "download";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast("文件已交给系统保存。");
}

function closePreview() {
  if (elements.previewDialog.open) {
    elements.previewDialog.close();
  } else {
    elements.previewDialog.removeAttribute("open");
  }
  revokePreviewUrl();
  state.selectedEntry = null;
  state.selectedData = null;
  elements.previewContent.replaceChildren();
}

function revokePreviewUrl() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
}

function closeArchive() {
  state.archive = null;
  state.entries = [];
  state.visibleEntries = [];
  elements.archiveSection.hidden = true;
  elements.fileList.replaceChildren();
  elements.searchInput.value = "";
  setStatus("准备就绪", "输入地址或选择一个本地归档。", "ready");
}

elements.urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawUrl = elements.archiveUrl.value.trim();
  if (!rawUrl) {
    showToast("请先输入远程 ZIP 地址。", true);
    elements.archiveUrl.focus();
    return;
  }
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("只支持 HTTP 或 HTTPS 地址。");
    }
    localStorage.setItem("huilianmeng:last-url", url.href);
    openSource(new HttpRangeSource(url.href));
  } catch (error) {
    showToast(error.message, true);
    elements.archiveUrl.focus();
  }
});

elements.chooseLocalButton.addEventListener("click", () => {
  elements.localFileInput.click();
});

elements.localFileInput.addEventListener("change", () => {
  const file = elements.localFileInput.files?.[0];
  elements.localFileInput.value = "";
  if (!file) return;
  openSource(new FileRandomAccessSource(file));
});

elements.searchInput.addEventListener("input", renderFiles);
elements.closeArchiveButton.addEventListener("click", closeArchive);
elements.closePreviewButton.addEventListener("click", closePreview);
elements.cancelPreviewButton.addEventListener("click", closePreview);
elements.downloadButton.addEventListener("click", downloadSelected);
elements.previewDialog.addEventListener("click", (event) => {
  if (event.target === elements.previewDialog) closePreview();
});
elements.previewDialog.addEventListener("close", revokePreviewUrl);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.hidden = false;
});

elements.installButton.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements.installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  elements.installButton.hidden = true;
  showToast("回联盟已添加到设备。");
});

const params = new URLSearchParams(location.search);
const deepLinkedUrl = params.get("url");
const savedUrl = localStorage.getItem("huilianmeng:last-url");
if (deepLinkedUrl) {
  elements.archiveUrl.value = deepLinkedUrl;
} else if (savedUrl) {
  elements.archiveUrl.value = savedUrl;
}

if (deepLinkedUrl && params.get("auto") === "1") {
  window.setTimeout(() => {
    try {
      const url = new URL(deepLinkedUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("只支持 HTTP 或 HTTPS 地址。");
      }
      openSource(new HttpRangeSource(url.href));
    } catch (error) {
      setStatus("地址无效", error.message, "error");
      showToast(error.message, true);
    }
  }, 180);
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

if (window.matchMedia("(display-mode: standalone)").matches) {
  elements.privacyStatus.textContent = "主屏幕应用";
}
