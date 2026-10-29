# Design knowledge

The only source the agent may use for standing reference questions ("what's our
primary color?", "give me the white logo as SVG"). One markdown file per topic, with
a `# Title` line. Anything not documented here, the agent declines to answer.

`make sync-brand` fills `brand/` from infisical.com/design.md, infisical.com/infisical-brand.css,
and infisical-brand.vercel.app (logos, assets, and the private Infisical/infisical-brand repo
through your `gh` login). `brand/` is gitignored because this repo is public. Rerun it when
the brand changes. Files named `README.md` are ignored.
