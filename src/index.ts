import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installExtension } from "./extension.ts";

export default function fastCompaction(pi: ExtensionAPI): void {
  installExtension(pi);
}
