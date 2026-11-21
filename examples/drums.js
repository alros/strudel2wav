// Uses Strudel's default sample library (needs a one-time download).
setcpm(120/4)

$: s("bd*4, [~ sd]*2, hh*8").bank("RolandTR909").gain(0.8)
$: note("<c2 c2 eb2 g1>").s("sawtooth").lpf(600).gain(0.5)
$: n("0 2 4 <7 9>").scale("C4:minor").s("piano").room(0.3).gain(0.6)
