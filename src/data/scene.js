export default {
  fps: 24,
  holds: [
    {
      id: "approach",
      title: "Approach",
      loop: { frames: 384 },
      hotspots: [],
    },
    {
      id: "deck",
      title: "Operations",
      section: true,
      hotspots: [
        { id: "profile", x: 31, y: 53, label: "Profile", enters: "profile" },
        { id: "core", x: 50, y: 49.8, label: "Meta Console", bare: true, enters: "core" },
        { id: "console", x: 69.3, y: 53, label: "Open the console", enters: "orbital" },
      ],
    },
  ],
};
