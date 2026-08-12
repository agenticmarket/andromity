import os
import sys
import subprocess
from pathlib import Path
import threading

def play_sound(sound_name: str = "done.wav"):
    """
    Play a sound file cross-platform without blocking.
    Assumes sound file is in the project root.
    """
    # Find sound file inside the package assets folder
    sound_path = Path(__file__).resolve().parent.parent / "assets" / "sounds" / sound_name
    
    if not sound_path.exists():
        return
        
    path_str = str(sound_path)
    
    def _play():
        try:
            if sys.platform == "win32":
                import winsound
                winsound.PlaySound(path_str, winsound.SND_FILENAME)
            elif sys.platform == "darwin":
                subprocess.run(["afplay", path_str], check=False)
            else:
                subprocess.run(["aplay", "-q", path_str], check=False, stderr=subprocess.DEVNULL)
        except Exception:
            pass
            
    threading.Thread(target=_play, daemon=True).start()
