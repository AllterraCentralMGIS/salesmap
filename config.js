// SalesMap configuration. Safe to commit — both keys below are public-by-design.
window.SALESMAP_CONFIG = {
  SUPABASE_URL: 'https://klkjpwgjnaozhatfopvd.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtsa2pwd2dqbmFvemhhdGZvcHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MDE1MzQsImV4cCI6MjA5NjE3NzUzNH0.OwH5DEb2L6tvJ9Ftp3JCm5NVgTG5ynQa6vQDHcYOoaw',

  // Map defaults — centered on Houston for first load before customers come in
  MAP_CENTER: [-95.37, 29.76],
  MAP_ZOOM: 8,

  // TomTom API key — set per-user via the in-app Settings dialog; or hard-code a
  // domain-restricted key here to skip the prompt. Leave blank to ask each user.
  DEFAULT_TOMTOM_KEY: '',
};
