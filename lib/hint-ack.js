/**
 * 「用户须知」确认状态落在当前 $DSH_HOME/dsh-purge，不进插件包。
 * 宿主端口每次启动都会变，浏览器 localStorage 按 origin 隔离，靠不住，
 * 所以必须由服务端文件持久化。文件不存在或读取失败一律按未确认处理。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function hintAckPath(dshHome) {
  return join(dshHome, "dsh-purge", "hint-ack.json");
}

export function readHintAck(dshHome) {
  const file = hintAckPath(dshHome);
  if (!existsSync(file)) return { acknowledged: false, path: file };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      acknowledged: !!(raw && raw.acknowledged === true),
      path: file,
      at: raw && raw.at ? raw.at : null,
    };
  } catch {
    return { acknowledged: false, path: file };
  }
}

export function writeHintAck(dshHome) {
  const file = hintAckPath(dshHome);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const at = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify({ acknowledged: true, at }, null, 2)}\n`, "utf8");
  try {
    if (existsSync(file)) unlinkSync(file);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 临时文件留不住就让原错误抛出 */ }
    throw error;
  }
  return readHintAck(dshHome);
}

/** 卸载时清掉确认状态：重装后应重新弹一次须知。 */
export function clearHintAck(dshHome) {
  const file = hintAckPath(dshHome);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
