# Test fixtures

- `gps-rotated.jpg`: 16x8 JPEG made with System.Drawing, then tagged with exiftool:
  `-ICC_Profile<=sRGB Color Space Profile.icm -Orientation#=6 -GPSLatitude=35.681236 -GPSLatitudeRef=N
  -GPSLongitude=139.767125 -GPSLongitudeRef=E -Make=TestCam -Model=Fixture`
- `gps.png`: 16x8 PNG with GPS and `Orientation#=6`.

Tests copy these files before processing and check that the originals never change.
