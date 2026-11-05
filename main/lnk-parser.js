'use strict';

/**
 * main/lnk-parser.js — Shell Link (.lnk) 二进制解析器（纯 JS，零依赖，不碰 PowerShell）。
 *
 * 用途：设置面板「拖入快捷方式/exe 快速添加 AI 源」。拖入 .lnk 时解析出
 * 目标 exe 路径，拖入 .exe 时直接取文件名。
 *
 * 格式依据 [MS-SHLLINK]：
 *   ShellLinkHeader (76B) -> LinkFlags 决定后续结构有无
 *   -> LinkTargetIDList (可选) -> LinkInfo (可选) -> StringData (可选)
 *
 * 目标提取优先级：LinkInfo.LocalBasePathUnicode > LocalBasePath(Ansi) >
 * StringData.RELATIVE_PATH。只认 .exe 结尾的目标；解析不出一律返回 null
 * （调用方走"部分填入 + 手动补"路径），任何截断/畸形输入都不允许抛出。
 *
 * 本模块纯数据无 IO 之外副作用，resolveDroppedFile 仅同步读被拖入的
 * 那个文件本身，可被 node 单测直接 require。
 */

const fs = require('fs');

const HEADER_SIZE = 0x4c;

// LinkFlags 位（[MS-SHLLINK] 2.1.1）
const FL = {
  HasLinkTargetIDList: 0x00000001,
  HasLinkInfo: 0x00000002,
  HasName: 0x00000004,
  HasRelativePath: 0x00000008,
  HasWorkingDir: 0x00000010,
  HasArguments: 0x00000020,
  HasIconLocation: 0x00000040,
  IsUnicode: 0x00000080,
};

/** 读一个以 \0 结尾的 ANSI 字符串；越界/无终止符返回 null。 */
function readAnsiZ(buf, offset) {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= buf.length) return null;
  const end = buf.indexOf(0x00, offset);
  if (end === -1) return null;
  const s = buf.slice(offset, end).toString('latin1');
  return s || null;
}

/** 读一个以 \0\0 结尾的 UTF-16LE 字符串；越界/无终止符返回 null。 */
function readUtf16Z(buf, offset) {
  if (!Number.isInteger(offset) || offset <= 0 || offset + 1 >= buf.length) return null;
  for (let i = offset; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      const s = buf.slice(offset, i).toString('utf16le');
      return s || null;
    }
  }
  return null;
}

/**
 * 读取 StringData 段的一个字符串（u16 字符计数 + 内容）。
 * @returns {{value: string|null, nextOffset: number}}
 */
function readCountedString(buf, offset, isUnicode) {
  if (offset + 2 > buf.length) return { value: null, nextOffset: buf.length + 1 };
  const count = buf.readUInt16LE(offset);
  const bytes = isUnicode ? count * 2 : count;
  const start = offset + 2;
  if (start + bytes > buf.length) return { value: null, nextOffset: buf.length + 1 };
  const value = isUnicode
    ? buf.slice(start, start + bytes).toString('utf16le')
    : buf.slice(start, start + bytes).toString('latin1');
  return { value: value || null, nextOffset: start + bytes };
}

/**
 * 解析 .lnk 文件内容。
 * @param {Buffer} buf
 * @returns {{targetPath: string|null, nameString: string|null}}
 *   targetPath = 目标 exe 的绝对/相对路径（未做 .exe 校验，调用方判）；
 *   结构不合法时两个字段都为 null（绝不抛异常）。
 */
function parseLnkBuffer(buf) {
  const empty = { targetPath: null, nameString: null };
  try {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return empty;
    if (buf.readUInt32LE(0) !== HEADER_SIZE) return empty; // HeaderSize 必须 0x4C
    const flags = buf.readUInt32LE(0x14);
    const isUnicode = (flags & FL.IsUnicode) !== 0;
    let offset = HEADER_SIZE;

    // LinkTargetIDList（存在则跳过）
    if (flags & FL.HasLinkTargetIDList) {
      if (offset + 2 > buf.length) return empty;
      const idListSize = buf.readUInt16LE(offset);
      offset += 2 + idListSize;
      if (offset > buf.length) return empty;
    }

    // LinkInfo
    // [MS-SHLLINK]：本地完整路径 = LocalBasePath + CommonPathSuffix（两段拼接！
    // 实测某些快捷方式是 LocalBasePath="C:\Users\" + Suffix="<user>\...\App.exe"，
    // 只读 LocalBasePath 会拿到半截路径）。Unicode 对优先，ANSI 对兜底。
    let localFullPath = null;
    if (flags & FL.HasLinkInfo) {
      if (offset + 4 > buf.length) return empty;
      const linkInfoSize = buf.readUInt32LE(offset);
      if (linkInfoSize < 0x1c || offset + linkInfoSize > buf.length) return empty;
      const li = offset; // LinkInfo 起始
      const linkInfoHeaderSize = buf.readUInt32LE(li + 4);
      const linkInfoFlags = buf.readUInt32LE(li + 8);
      // bit0 VolumeIDAndLocalBasePath：本地路径才取（网络路径对进程监测无意义）
      if (linkInfoFlags & 0x1) {
        // 偏移为 0 = 该字段不存在（真实 lnk 常见），绝不能拿 LinkInfo 头部
        // 自己当字符串读（会把尺寸字节拼进路径）。
        const offLocalBasePath = buf.readUInt32LE(li + 0x10);
        const offCommonPathSuffix = buf.readUInt32LE(li + 0x18);
        const ansiBase = offLocalBasePath ? readAnsiZ(buf, li + offLocalBasePath) : null;
        const ansiSuffix = offCommonPathSuffix ? readAnsiZ(buf, li + offCommonPathSuffix) : null;
        let uniBase = null;
        let uniSuffix = null;
        // LinkInfoHeaderSize >= 0x24 才有 Unicode 偏移字段
        if (linkInfoHeaderSize >= 0x24) {
          const offLocalBasePathUnicode = buf.readUInt32LE(li + 0x1c);
          const offCommonPathSuffixUnicode = buf.readUInt32LE(li + 0x20);
          uniBase = offLocalBasePathUnicode ? readUtf16Z(buf, li + offLocalBasePathUnicode) : null;
          uniSuffix = offCommonPathSuffixUnicode ? readUtf16Z(buf, li + offCommonPathSuffixUnicode) : null;
        }
        const joinPath = (base, suffix) => {
          if (base && suffix) return base + suffix;
          return base || suffix || null;
        };
        localFullPath = joinPath(uniBase, uniSuffix) || joinPath(ansiBase, ansiSuffix);
      }
      offset += linkInfoSize;
    }

    // StringData：顺序固定 NAME -> RELATIVE_PATH -> WORKING_DIR -> ARGUMENTS -> ICON_LOCATION
    let nameString = null;
    let relativePath = null;
    const slots = [
      [FL.HasName, (v) => (nameString = v)],
      [FL.HasRelativePath, (v) => (relativePath = v)],
      [FL.HasWorkingDir, () => {}],
      [FL.HasArguments, () => {}],
      [FL.HasIconLocation, () => {}],
    ];
    for (const [flag, assign] of slots) {
      if (!(flags & flag)) continue;
      if (offset >= buf.length) break; // 截断容忍：能读几个读几个
      const { value, nextOffset } = readCountedString(buf, offset, isUnicode);
      if (nextOffset > buf.length) break;
      if (value) assign(value);
      offset = nextOffset;
    }

    return {
      targetPath: localFullPath || relativePath || null,
      nameString,
    };
  } catch {
    return empty; // 任何畸形输入都不抛（截断 Buffer 的 readUInt 会抛 RangeError）
  }
}

/** 从路径里提取文件名（兼容 \ 和 / 分隔符，lnk 里可能存正斜杠）。 */
function baseName(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return idx === -1 ? s : s.slice(idx + 1);
}

/** 去掉文件名的最后一个扩展名。 */
function stripExt(name) {
  const s = String(name || '');
  const idx = s.lastIndexOf('.');
  return idx > 0 ? s.slice(0, idx) : s;
}

/**
 * 解析拖入的文件，产出设置面板可直接使用的 {displayName, processName}。
 *
 * @param {string} filePath 拖入文件的绝对路径
 * @returns
 *   快捷方式/ exe 识别成功: { ok: true, displayName, processName, targetPath }
 *   .lnk 解析失败或目标非 exe: { ok: false, partial: true, displayName, processName: '', error }
 *   不支持的扩展名: { ok: false, partial: false, error }
 *   文件读不到: { ok: false, partial: false, error }
 */
function resolveDroppedFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p) {
    return { ok: false, partial: false, error: '未获取到文件路径' };
  }
  const fileName = baseName(p);
  const ext = (fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '').toLowerCase();

  if (ext === '.exe') {
    return {
      ok: true,
      displayName: stripExt(fileName),
      processName: fileName,
      targetPath: p,
    };
  }

  if (ext !== '.lnk') {
    return { ok: false, partial: false, error: '只支持快捷方式(.lnk)或 exe' };
  }

  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    return { ok: false, partial: false, error: `文件读取失败：${err && err.message}` };
  }
  const { targetPath } = parseLnkBuffer(buf);
  const displayName = stripExt(fileName); // 快捷方式名通常是中文应用名（"豆包"/"阿布"）
  if (targetPath && baseName(targetPath).toLowerCase().endsWith('.exe')) {
    return {
      ok: true,
      displayName,
      processName: baseName(targetPath), // 如 Doubao.exe / abu.exe
      targetPath,
    };
  }
  return {
    ok: false,
    partial: true,
    displayName,
    processName: '',
    error: '未能识别进程名，请手动补',
  };
}

module.exports = { parseLnkBuffer, resolveDroppedFile, baseName, stripExt };
