set -e
cd "$(dirname "$0")"
# voice track: each line delayed to its start, slight room reverb, loud
ARGS=""; MAP=""; i=0
while IFS='|' read t txt; do i=$((i+1)); ms=$(python3 -c "print(int($t*1000))")
  ARGS="$ARGS -i vo/$(printf l%02d $i).aiff"
  MAP="$MAP[$((i-1)):a]adelay=${ms}|${ms},volume=1.6[v$i];"
done < lines.txt
MIX=$(for j in $(seq 1 $i); do printf "[v%d]" $j; done)
ffmpeg -y -loglevel error $ARGS -filter_complex "${MAP}${MIX}amix=inputs=$i:normalize=0,aecho=0.8:0.5:40:0.12,loudnorm=I=-14:TP=-1.5[voice]" -map "[voice]" -ar 44100 voice.wav
# duck music under voice, then mix with voice
ffmpeg -y -loglevel error -i music.wav -i voice.wav -filter_complex "[1:a]apad=whole_dur=46,asplit=2[vsc][vout];[0:a][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];[duck][vout]amix=inputs=2:weights=0.9 1.3:normalize=0:duration=first,alimiter=limit=0.95[mix]" -map "[mix]" -t 46 -ar 44100 -ac 2 final_audio.wav
echo audio ok
