// "Chrome on Mac" from a User-Agent header: a new passkey's default name, and how Settings names a session.
// Plain module: the server, the UI and tests import it.
// ponytail: a few regexes, not a parser. An unknown browser comes out as the OS alone, or "Unknown device".
export function deviceName(ua: string | null | undefined): string {
	const s = ua ?? "";
	const browser = /Edg\w*\//.test(s) ? "Edge" : /Firefox\/|FxiOS\//.test(s) ? "Firefox" : /Chrome\/|CriOS\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
	const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux|CrOS/.test(s) ? "Linux" : "";
	return browser && os ? `${browser} on ${os}` : browser || os || "Unknown device";
}
