# Test fixtures

- `gps-rotated.jpg`: 16x8 JPEG made with System.Drawing, then tagged with exiftool:
  `-ICC_Profile<=sRGB Color Space Profile.icm -Orientation#=6 -GPSLatitude=35.681236 -GPSLatitudeRef=N
  -GPSLongitude=139.767125 -GPSLongitudeRef=E -Make=TestCam -Model=Fixture`
- `gps.png`: 16x8 PNG with GPS and `Orientation#=6`.
- `inkscape.svg`, `illustrator.svg`: hand-written SVGs shaped like Inkscape and Illustrator files, with `<metadata>`, editor
  namespaces, and comments. `foreign-object.svg` has HTML text in `<foreignObject>` like a draw.io export.
  `embedded-photo.svg` embeds `gps.png` as a data: URL. `plain.svg` has nothing to remove.

Tests copy these files before processing and check that the originals never change.
