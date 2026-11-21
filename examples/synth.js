// Synth-only example: needs no samples, renders fully offline.
setcps(0.5)

$: note("<c3 eb3 g3 bb3>*4").s("sawtooth").lpf(sine.range(400, 2000).slow(4)).lpq(5).gain(0.5)
$: note("<c5 g5 eb5 d5>").s("triangle").room(0.5).delay(0.25).gain(0.3)
