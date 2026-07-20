# Outfit image prompt

Use this template with all identity references first, then the exact wardrobe cutouts in the listed order. Replace the image-number placeholders after counting the identity references. Delete optional clauses that do not apply.

```text
Use case: identity-preserve
Asset type: square outfit gallery photograph

Images 1 through [N]: complementary identity references for the same exact person to preserve.
Image [N+1]: exact top garment reference.
Image [N+2]: exact bottom garment reference.
[Image [N+3]: exact outer-layer reference. Preserve its real construction and closure exactly; never invent a zipper, buttons, placket, or opening.]
[Image [N+4]: exact shoe or accessory reference.]

Primary request: Create a professional square editorial fashion photograph of the same person shown across Images 1 through [N], wearing all of the exact referenced garments and only those garments. Synthesize the identity references as complementary face, hair, build, skin-tone, and body-proportion evidence; never average them into a different person or show more than one person.

Outfit: [OUTFIT NAME]
Scene/backdrop: [RESTRAINED REAL-WORLD SETTING].

Subject: Preserve the same person's recognizable face, hair, age, build, skin texture, and body proportions. Dress them in the exact top and bottom references[ plus the exact outer-layer reference][ and the exact selected shoes/accessory]. Plain understated shoes and invisible basics such as socks are allowed only where needed when no shoe reference is provided. Do not add, replace, or invent any other visible clothing or accessory.

Style/medium: Photorealistic natural editorial fashion campaign with authentic skin and fabric texture and no synthetic AI polish.

Composition/framing: Square 1:1 image. Show the complete person and outfit from head through shoes. Keep the person centered and occupying most of the frame with modest breathing room. Use a relaxed, mostly front-facing pose with arms away from the torso so every item remains readable.

Lighting/mood: Warm professional natural light, realistic shadows, and restrained editorial color grading.

Garment fidelity: Preserve every referenced garment precisely: color, material, fit, construction, pattern, graphics, logos, text, proportions, distinctive details, and real closure construction. Keep the top and bottom recognizable without changing their natural length, tuck, or construction.

[Layered-look clause: Layer the exact inner top and outer layer naturally so both remain visibly identifiable. First inspect the outer reference. If it has a real full front button or zipper closure, it may be worn naturally open or partly open using only that closure. If it is a pullover or has no full front opening, keep it closed exactly as designed and reveal the inner top only at its real collar or neckline, sleeve or cuff edge, or a natural 2–4 cm untucked hem below the outer layer. Never invent, add, split, unzip, unbutton, or simulate a closure. Keep the outer garment at its true length even when it overlaps the waistband.]

Avoid: Completely hidden selected garments, invented zippers, buttons, openings or plackets, unnatural layering, extra layers, hats, bags, scarves, jewelry, visible unreferenced undershirts, crossed arms, hands blocking clothing, garment redesign, changed logos or text, cropped feet, extra people, text overlays, watermarks, studio cutout appearance, or synthetic AI polish.
```

Use a corrective pass rather than repeating the same prompt when an output fails. Attach the failed output and exact references, name the concrete failure, preserve successful parts, and restate the relevant fidelity or layering constraint.
