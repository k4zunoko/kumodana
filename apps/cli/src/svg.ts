import sax, { type QualifiedTag } from "sax";
import { CliError } from "./errors.ts";

/**
 * Removes what an SVG carries besides the drawing before `kumo put` sends it: `<metadata>`, the elements and attributes
 * of drawing programs with their namespace declarations, and comments. Every other character stays exactly as it was,
 * so the drawing looks the same. A parse-and-serialize optimizer such as svgo would also drop whitespace between
 * HTML elements in `<foreignObject>`, which changes how the text there is shown.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Namespaces that only drawing programs read (the `editorNamespaces` of svgo 4.1.0). */
const EDITOR_NAMESPACES = new Set([
	"http://creativecommons.org/ns#",
	"http://inkscape.sourceforge.net/DTD/sodipodi-0.dtd",
	"http://krita.org/namespaces/svg/krita",
	"http://ns.adobe.com/AdobeIllustrator/10.0/",
	"http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/",
	"http://ns.adobe.com/Extensibility/1.0/",
	"http://ns.adobe.com/Flows/1.0/",
	"http://ns.adobe.com/GenericCustomNamespace/1.0/",
	"http://ns.adobe.com/Graphs/1.0/",
	"http://ns.adobe.com/ImageReplacement/1.0/",
	"http://ns.adobe.com/SaveForWeb/1.0/",
	"http://ns.adobe.com/Variables/1.0/",
	"http://ns.adobe.com/XPath/1.0/",
	"http://purl.org/dc/elements/1.1/",
	"http://schemas.microsoft.com/visio/2003/SVGExtensions/",
	"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
	"http://taptrix.com/vectorillustrator/svg_extensions",
	"http://www.bohemiancoding.com/sketch/ns",
	"http://www.figma.com/figma/ns",
	"http://www.inkscape.org/namespaces/inkscape",
	"http://www.serif.com/",
	"http://www.vector.evaxdesign.sk",
	"http://www.w3.org/1999/02/22-rdf-syntax-ns#",
	"https://boxy-svg.com",
]);

/** One attribute of a start tag, with the whitespace before it. */
const ATTRIBUTE = /\s+([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/y;
/** A raster image in a data: URL (an `href`, or `url()` in CSS). */
const EMBEDDED_IMAGE = /data:image\/(?!svg\+xml)[\w.+-]+/i;

export const EMBEDDED_IMAGE_WARNING =
	"data: URL で埋め込まれた画像（JPEG、PNG など）のメタデータは取り除いていません。位置情報などは、埋め込む前の画像から消してください。";

export type CleanedSvg = { data: Uint8Array; warnings: string[] };

export function removeSvgMetadata(bytes: Uint8Array): CleanedSvg {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw unreadable("UTF-8 ではありません");
	}

	const cuts: [start: number, end: number][] = [];
	const parser = sax.parser(true, { xmlns: true, position: true });
	let cutStart = 0;
	let cutDepth = 0;
	parser.onopentag = (node) => {
		const tag = node as QualifiedTag;
		if (cutDepth > 0 || EDITOR_NAMESPACES.has(tag.uri) || (tag.uri === SVG_NAMESPACE && tag.local === "metadata")) {
			if (cutDepth === 0) cutStart = parser.startTagPosition - 1;
			cutDepth++;
			return;
		}
		const names = new Set(
			Object.values(tag.attributes)
				.filter((a) => EDITOR_NAMESPACES.has(a.prefix === "xmlns" ? a.value : a.uri))
				.map((a) => a.name),
		);
		if (names.size > 0) cuts.push(...attributeCuts(text, parser.startTagPosition + tag.name.length, names));
	};
	parser.onclosetag = () => {
		if (cutDepth > 0 && --cutDepth === 0) cuts.push([cutStart, parser.position]);
	};
	// Called at the second "-" of "-->".
	parser.oncomment = () => {
		if (cutDepth === 0) cuts.push([parser.startTagPosition - 1, parser.position + 1]);
	};
	parser.onerror = (error) => {
		throw unreadable(error.message.split("\n")[0] ?? error.message);
	};
	parser.write(text).close();

	let kept = "";
	let from = 0;
	for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
		kept += text.slice(from, start);
		from = end;
	}
	kept += text.slice(from);
	return {
		data: cuts.length > 0 ? new TextEncoder().encode(kept) : bytes,
		warnings: EMBEDDED_IMAGE.test(kept) ? [EMBEDDED_IMAGE_WARNING] : [],
	};
}

/** The ranges of the named attributes in the start tag whose attributes begin at `from`. */
function attributeCuts(text: string, from: number, names: Set<string>): [number, number][] {
	const cuts: [number, number][] = [];
	ATTRIBUTE.lastIndex = from;
	for (let match = ATTRIBUTE.exec(text); match; match = ATTRIBUTE.exec(text)) {
		if (names.has(match[1] ?? "")) cuts.push([match.index, match.index + match[0].length]);
	}
	if (cuts.length !== names.size) throw unreadable("属性を読み取れません");
	return cuts;
}

function unreadable(reason: string): CliError {
	return new CliError(`SVG として読み取れないため、メタデータを取り除けませんでした（${reason}）。`, {
		code: "invalid_svg",
		hint: "メタデータを残したまま置くには、--keep-exif を付けてください。",
	});
}
