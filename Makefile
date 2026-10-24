
dev:
	setsid sh -c 'cd desktop && npm run app'

install:
	rm -rf $(HOME)/.local/bin/LocalLeaf

	cd desktop && npx tauri build


	cp target/release/bundle/appimage/LocalLeaf_1.0.1_amd64.AppImage $(HOME)/.local/bin/LocalLeaf
	chmod +x $(HOME)/.local/bin/LocalLeaf

	mkdir -p $(HOME)/.local/share/applications
	cp desktop/src-tauri/icons/128x128@2x.png $(HOME)/.local/share/applications/LocalLeaf.png
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

	echo "Installed LocalLeaf to ~/.local/bin and desktop entry to ~/.local/share/applications"
