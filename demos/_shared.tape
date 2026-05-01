# Shared header — sourced by every Rendobar demo tape.
# Keeps look-and-feel consistent across the catalogue.

Set Theme         '{ "name": "Rendobar", "background": "#0b0b0d", "foreground": "#f7f8f8", "cursor": "#6ee7b7", "selection": "#0596694D", "black": "#1d1d20", "red": "#e7000b", "green": "#059669", "yellow": "#fcd34d", "blue": "#67e8f9", "magenta": "#c4b5fd", "cyan": "#6ee7b7", "white": "#d6d7db", "brightBlack": "#7d7f8c", "brightRed": "#f87171", "brightGreen": "#6ee7b7", "brightYellow": "#fde68a", "brightBlue": "#93c5fd", "brightMagenta": "#d8b4fe", "brightCyan": "#a5f3fc", "brightWhite": "#ffffff" }'
Set Shell         "bash"
Set FontFamily    "JetBrains Mono"
Set FontSize      24
Set Width         1280
Set Height        720
Set Padding       80
Set Margin        0
Set BorderRadius  0
Set WindowBar     Colorful
Set WindowBarSize 44
Set TypingSpeed   45ms
Set PlaybackSpeed 1.0
Set Framerate     50
Set LoopOffset    0%
Set CursorBlink   true

# Inherits parent PATH — caller prepends demos/bin/.
# Local:  PATH="$PWD/demos/bin:$PATH" vhs demos/hero.tape
# CI:     workflow prepends demos/bin/ before invoking vhs
Env PS1          "▸ "
Env TERM         "xterm-256color"
Env FORCE_COLOR  "1"
Env CLICOLOR     "1"
