#!/bin/bash
set -e

# UnRepost macOS Application Bundle Builder
# Builds a double-clickable UnRepost.app in dist/

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
APP_DIR="$DIST_DIR/UnRepost.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
APP_PAYLOAD_DIR="$RESOURCES_DIR/app"

echo "=========================================="
echo "    Building UnRepost.app for macOS       "
echo "=========================================="

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"
mkdir -p "$APP_PAYLOAD_DIR"

# 1. Write Info.plist
cat << 'EOF' > "$CONTENTS_DIR/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>UnRepost</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.unrepost.app</string>
    <key>CFBundleName</key>
    <string>UnRepost</string>
    <key>CFBundleDisplayName</key>
    <string>UnRepost</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

# 2. Write Launcher Script (Executable)
cat << 'EOF' > "$MACOS_DIR/UnRepost"
#!/bin/bash
DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"

# Helper function for native dialogs
show_dialog() {
  local title="$1"
  local msg="$2"
  local btn1="$3"
  local btn2="$4"
  osascript -e "display dialog \"$msg\" with title \"$title\" buttons {\"$btn1\", \"$btn2\"} default button 2 with icon caution" 2>/dev/null
}

# 1. Locate Node.js runtime
NODE_BIN=""
SEARCH_PATHS=(
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)/bin/node"
  "$(which node 2>/dev/null)"
)

for p in "${SEARCH_PATHS[@]}"; do
  if [ -n "$p" ] && [ -x "$p" ]; then
    NODE_BIN="$p"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  RESP=$(osascript -e 'display dialog "UnRepost requires the free Node.js runtime to execute locally on your Mac.\n\nPlease install the LTS version from https://nodejs.org" with title "UnRepost - Node.js Required" buttons {"Cancel", "Download Node.js"} default button 2 with icon caution' 2>/dev/null || echo "button returned:Cancel")
  if [[ "$RESP" == *"Download Node.js"* ]]; then
    open "https://nodejs.org/"
  fi
  exit 1
fi

# 2. Locate Chromium browser
CHROME_BIN=""
if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -f "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ]; then
  CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
elif [ -f "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
  CHROME_BIN="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
fi

# 3. Start Local Engine
export UNREPOST_APP_MODE="true"
"$NODE_BIN" "$DIR/unrepost.js" > /dev/null 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 4. Wait for server to bind on 127.0.0.1:3210 (up to 12s)
READY=0
for i in {1..24}; do
  if curl -s "http://127.0.0.1:3210/api/state" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  osascript -e 'display alert "UnRepost Error" message "Failed to start the local engine server. Please check permissions." as critical'
  exit 1
fi

# 5. Open GUI Window
if [ -n "$CHROME_BIN" ]; then
  # Native App Window (borderless clean window without tabs or URL bar)
  "$CHROME_BIN" --app="http://127.0.0.1:3210" --window-size=1280,860 > /dev/null 2>&1 &
  CHROME_PID=$!
  wait "$CHROME_PID" 2>/dev/null || true
else
  # Fallback to default browser
  open "http://127.0.0.1:3210"
  wait "$SERVER_PID" 2>/dev/null || true
fi
EOF

chmod +x "$MACOS_DIR/UnRepost"

# 3. Copy application files into Contents/Resources/app
cp "$PROJECT_ROOT/unrepost.js" "$APP_PAYLOAD_DIR/"
cp "$PROJECT_ROOT/package.json" "$APP_PAYLOAD_DIR/"
cp -R "$PROJECT_ROOT/public" "$APP_PAYLOAD_DIR/"

# Symlink or copy node_modules if present
if [ -d "$PROJECT_ROOT/node_modules" ]; then
  cp -R "$PROJECT_ROOT/node_modules" "$APP_PAYLOAD_DIR/"
fi

# 4. Generate AppIcon.icns
ICONSET_DIR="/tmp/UnRepost.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

python3 - << 'PYEOF'
import struct, zlib

def make_png(filename, size):
    width, height = size, size
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)
        for x in range(width):
            dx = x - width / 2
            dy = y - height / 2
            r = (dx*dx + dy*dy) ** 0.5
            radius = width * 0.44
            if r <= radius:
                # TikTok dark gradient
                t = (x + y) / (width + height)
                red = int(22 + (254 - 22) * t * 0.4)
                green = int(24 + (44 - 24) * t * 0.4)
                blue = int(35 + (85 - 35) * t * 0.4)
                # Cyan accent dot
                cdx = x - width * 0.38
                cdy = y - height * 0.38
                if (cdx*cdx + cdy*cdy) ** 0.5 < width * 0.12:
                    red, green, blue = 37, 244, 238
                raw_data.extend([red, green, blue, 255])
            else:
                raw_data.extend([0, 0, 0, 0])

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(bytes(raw_data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')
    with open(filename, 'wb') as f:
        f.write(png)

for sz in [16, 32, 64, 128, 256, 512]:
    make_png(f"/tmp/UnRepost.iconset/icon_{sz}x{sz}.png", sz)
    if sz <= 256:
        make_png(f"/tmp/UnRepost.iconset/icon_{sz}x{sz}@2x.png", sz * 2)
PYEOF

iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns" 2>/dev/null || true
rm -rf "$ICONSET_DIR"

echo "=========================================="
echo "  Success! Application created at:        "
echo "  $APP_DIR"
echo "=========================================="
