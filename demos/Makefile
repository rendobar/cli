# Build the hero demo recording. Run from cli/ root.
#
#   make -C demos          regenerate hero
#   make -C demos clean    wipe out/
#
# Requires:  vhs (https://github.com/charmbracelet/vhs)
#            ttyd, ffmpeg, JetBrains Mono installed.
# CI uses the official ghcr.io/charmbracelet/vhs image.

VHS ?= vhs

.PHONY: all clean hero

all: hero

hero: out/hero.gif

out/hero.gif: hero.tape _shared.tape bin/rb | out
	@chmod +x bin/rb 2>/dev/null || true
	@cd .. && PATH="$$PWD/demos/bin:$$PATH" $(VHS) demos/hero.tape

out:
	@mkdir -p out

clean:
	rm -rf out
