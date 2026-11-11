// Site settings. Edit these, commit, and the site redeploys.
window.GA_CONFIG = {
  siteTitle: "Gregory Archive",
  storyUrl: "https://gregoryarchive.org",

  // Public data file built from the Google Sheet by GitHub Actions.
  dataUrl: "data/archive.json",

  // Original scans in S3. To cut AWS costs, put a CloudFront distribution in front of the
  // bucket and use its address here and below (e.g. https://d1234abcd.cloudfront.net/).
  imageBase: "https://gregoryslides.s3.amazonaws.com/",

  // Thumbnails made by scripts/make_thumbnails.py (WebP).
  // Leave thumbsReady false until the first thumbnail run finishes;
  // cards fall back to the original image if a thumbnail is missing.
  thumbBase: "https://gregoryslides.s3.amazonaws.com/thumbs/400/",
  mediumBase: "https://gregoryslides.s3.amazonaws.com/thumbs/1600/",
  thumbsReady: false,

  // Google Apps Script web app URL (see apps-script/Code.gs). Used by the editor only.
  appsScriptUrl: "",

  // Fields shown on cards and in the short info panel.
  keyFields: ["Title", "Subject", "Location", "Date of Subject", "Date Created", "Slide Box", "Creator"],
  // Fields offered as filters. The first four get their own button; the rest sit under "More".
  facetFields: ["Slide Box", "Location", "Subject", "Creator", "Digitizer 1", "Digitizer 2", "Medium", "Format", "Class", "Device", "Date digitized"],

  // Base of each slide's permanent link: <permalinkBase>#slide/GA000123.
  // Change it once if you move to a custom domain (e.g. "https://slides.gregoryarchive.org/").
  permalinkBase: "https://tregodan.github.io/gregoryarchive-site/",

  // Photos of the physical slide boxes, copied from Airtable by scripts/thumbs_from_airtable.py.
  boxPhotoBase: "https://gregoryslides.s3.amazonaws.com/boxes/",

  // Optional override photo for a slide box in the Slide Boxes view, keyed by the exact box name.
  // Boxes without one show a mosaic of their first slides.
  // e.g. "1  BYZANTINE ART A_HISTORY IKONS": "https://gregoryslides.s3.amazonaws.com/boxes/box01.jpg",
  boxCovers: {},
};
