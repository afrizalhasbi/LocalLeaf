SIDECAR := target/release/localleaf-sidecar
APPDIR := $(HOME)/.local/share/LocalLeaf

dev:
	setsid sh -c 'cd desktop && npx vite & \
		cd desktop && until curl -s -o /dev/null http://localhost:1420; do sleep 0.3; done && \
		ELECTRON_START_URL=http://localhost:1420 electron .'

sidecar:
	cargo build --release -p localleaf-sidecar

# Installs the app as a plain directory run by the system Electron
# (pacman -S electron). No bundler, no packaged Chromium download.
install: sidecar
	rm -rf $(APPDIR) $(HOME)/.local/bin/LocalLeaf

	cd desktop && npx vite build

	mkdir -p $(APPDIR)/resources/sidecar
	cp $(SIDECAR) $(APPDIR)/resources/sidecar/localleaf-sidecar
	cp desktop/package.json $(APPDIR)/package.json
	cp -r desktop/dist $(APPDIR)/dist
	cp -r desktop/electron $(APPDIR)/electron
	cp -r desktop/icons $(APPDIR)/icons

	printf '%s\n' \
		'#!/bin/sh' \
		'exec /usr/bin/electron $(APPDIR) "$@"' \
		> $(HOME)/.local/bin/LocalLeaf
	chmod +x $(HOME)/.local/bin/LocalLeaf

	mkdir -p $(HOME)/.local/share/applications
	cp desktop/icons/128x128@2x.png $(HOME)/.local/share/applications/LocalLeaf.png
	printf '%s\n' \
		'[Desktop Entry]' \
		'Name=LocalLeaf' \
		'Comment=Local tex editor' \
		'Icon=LocalLeaf.png' \
		'Exec=/home/host/.local/bin/LocalLeaf' \
		'Terminal=false' \
		'Type=Application' \
		'Categories=Utility;Development;' \
		> $(HOME)/.local/share/applications/LocalLeaf.desktop

	echo "Installed LocalLeaf to ~/.local/bin (uses the system Electron) and desktop entry to ~/.local/share/applications"
