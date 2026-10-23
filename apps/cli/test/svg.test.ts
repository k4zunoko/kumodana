import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import { EMBEDDED_IMAGE_WARNING, removeSvgMetadata } from "../src/svg.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const clean = (text: string) => new TextDecoder().decode(removeSvgMetadata(encode(text)).data);
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

describe("removeSvgMetadata", () => {
	it("cuts out <metadata>, drawing programs' elements and attributes, and comments, and keeps every other character", () => {
		const svg = [
			'<?xml version="1.0"?>',
			"<!-- Created with Inkscape -->",
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3" viewBox="0 0 10 10">',
			"  <metadata><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">Taro</rdf:RDF></metadata>",
			'  <inkscape:page id="p"><inkscape:x/></inkscape:page>',
			"  <rect  id=\"r\"\n\tinkscape:label='a \"b\" c' width=\"1\"/><!-- note -->",
			'  <g xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" sodipodi:docname="x.svg"><text>a  <tspan>b</tspan> c</text></g>',
			"</svg>",
		].join("\n");
		expect(clean(svg)).toBe(
			[
				'<?xml version="1.0"?>',
				"",
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
				"  ",
				"  ",
				'  <rect  id="r" width="1"/>',
				"  <g><text>a  <tspan>b</tspan> c</text></g>",
				"</svg>",
			].join("\n"),
		);
	});

	it("keeps the whitespace between HTML elements in <foreignObject>", async () => {
		const out = new TextDecoder().decode(removeSvgMetadata(await fixture("foreign-object.svg")).data);
		expect(out).toContain("Hello <b>big</b> <i>world</i> と 図</div>");
		expect(out).not.toContain("<!--");
	});

	it("returns the same bytes when there is nothing to remove, including a BOM", async () => {
		const plain = await fixture("plain.svg");
		expect(removeSvgMetadata(plain)).toEqual({ data: plain, warnings: [] });
		const withBom = encode('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"><!-- x --></svg>');
		expect([...removeSvgMetadata(withBom).data.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	it("warns about raster images in data: URLs, but not about SVG ones", async () => {
		expect(removeSvgMetadata(await fixture("embedded-photo.svg")).warnings).toEqual([EMBEDDED_IMAGE_WARNING]);
		const css = '<svg xmlns="http://www.w3.org/2000/svg"><style>rect { fill: url("data:image/JPEG;base64,/9j/") }</style></svg>';
		expect(removeSvgMetadata(encode(css)).warnings).toEqual([EMBEDDED_IMAGE_WARNING]);
		const svgInSvg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,%3Csvg%3E"/></svg>';
		expect(removeSvgMetadata(encode(svgInSvg)).warnings).toEqual([]);
	});

	it.each([
		["not well-formed XML", encode('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>')],
		["an unbound prefix", encode('<svg xmlns="http://www.w3.org/2000/svg"><x:rect/></svg>')],
		["not UTF-8", new Uint8Array([...encode('<svg xmlns="http://www.w3.org/2000/svg"><text>'), 0x93, 0xfa, ...encode("</text></svg>")])],
	])("refuses an SVG that is %s and points to --keep-exif", (_, bytes) => {
		let error: unknown;
		try {
			removeSvgMetadata(bytes);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CliError);
		expect(error).toMatchObject({ code: "invalid_svg", hint: expect.stringContaining("--keep-exif") });
	});
});
