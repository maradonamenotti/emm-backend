const token = "EABAyu2qw7GYBRnWY8e68Wds5y2x6IriDwIrpJZBZBB1dj1tmdYZAvRaK22Dg8RZBJshoqSftwXpCSN6BZC31glNDd9gqY9X1cnfm6OJBFaPa3NXuWo2xIPB2meSCKfKvCcUFonZBrMMo2pUViLyfnCgfcVreQEWsq2LyHiZCwJVJJZCTFFI3EBdZCPh7suIF5UO9CGJU33rCm3TEmnHzaPswXQiwkhikOH2zOOOJc8FmWqyAsmL9AqpW1Dt7wCJUtaeKeAXIhCzToesnwhtahnFz90CONip2AKMjA";
fetch(`https://graph.facebook.com/v19.0/debug_token?input_token=${token}&access_token=${token}`)
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);
