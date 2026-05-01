# hero.tape — landing page hero, README top, social media reel.
# 13 second loop. Local file → cloud render → URL.

Source demos/_shared.tape

Output demos/out/hero.gif
Output demos/out/hero.mp4
Output demos/out/hero.webm

Hide
Type "clear" Enter
Show

Sleep 1s
Set TypingSpeed 35ms
Type "rb ffmpeg -i intro.mp4 -vf scale=1920:1080 intro-1080p.mp4"
Sleep 600ms
Enter

Sleep 7s
Sleep 2400ms
