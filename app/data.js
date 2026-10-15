// Fake sample data is gone. Pages read everything live through MC.api.
// MC.projects (and MC.byId) stay only because project.html line "MC.projects.some(...)" still reads them. Nothing else uses them.
window.MC = window.MC || {};
MC.projects = [];
MC.byId = id => MC.projects.find(p => p.id === id) || null;
