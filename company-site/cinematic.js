const cinematicStory = document.querySelector("[data-cinematic-story]");

if (cinematicStory) {
  const pin = cinematicStory.querySelector("[data-cinematic-pin]");
  const chapters = [...cinematicStory.querySelectorAll("[data-cinematic-chapter]")];
  const progressBar = cinematicStory.querySelector("[data-cinematic-progress]");
  const jumpLinks = [...document.querySelectorAll("[data-story-jump]")];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const storyStops = [0, 0.18, 0.30, 0.45, 0.56, 0.70, 0.82, 0.97];
  const magneticDistance = 0.022;
  const breakdowns = [...cinematicStory.querySelectorAll('[data-breakdown]')].map((element, index) => ({
    element, start: 0.22 + index * 0.26,
    area: element.querySelector('.breakdown-parts'), width: 0, height: 0,
    parts: [...element.querySelectorAll('.product-part')],
  }));
  const compactView = window.matchMedia('(max-width: 680px)');
  const filmTimeline = [[0, 0], [0.18, 0.35], [0.22, 0.37], [0.38, 0.38],
    [0.45, 0.55], [0.48, 0.57], [0.64, 0.58], [0.70, 0.75], [0.74, 0.77],
    [0.90, 0.80], [0.97, 0.95], [1, 1]];
  let targetProgress = 0;
  let filmProgress = 0;
  let animationFrame = 0;
  let lastFrameTime = 0;
  let snapTimer = 0;
  let snapReleaseTimer = 0;
  let isMagnetizing = false;
  let isTouching = false;

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const smooth = (value) => {
    const t = clamp(value);
    return t * t * (3 - 2 * t);
  };
  const range = (progress, start, end) => smooth((progress - start) / (end - start));
  const windowed = (progress, fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd) =>
    range(progress, fadeInStart, fadeInEnd) * (1 - range(progress, fadeOutStart, fadeOutEnd));
  const keyframed = (progress, frames) => {
    if (progress <= frames[0][0]) return frames[0][1];
    for (let index = 1; index < frames.length; index += 1) {
      const [endProgress, endValue] = frames[index];
      const [startProgress, startValue] = frames[index - 1];
      if (progress <= endProgress) {
        const length = endProgress - startProgress;
        const phase = clamp((progress - startProgress) / length);
        const slope = (endValue - startValue) / length;
        const tangent = (left, right) => left * right <= 0 ? 0 : 2 * left * right / (left + right);
        const previous = index > 1 ? (startValue - frames[index - 2][1]) / (startProgress - frames[index - 2][0]) : 0;
        const next = index + 1 < frames.length ? (frames[index + 1][1] - endValue) / (frames[index + 1][0] - endProgress) : 0;
        const a = tangent(previous, slope) * length;
        const b = tangent(slope, next) * length;
        return (2 * phase ** 3 - 3 * phase ** 2 + 1) * startValue +
          (phase ** 3 - 2 * phase ** 2 + phase) * a +
          (-2 * phase ** 3 + 3 * phase ** 2) * endValue +
          (phase ** 3 - phase ** 2) * b;
      }
    }
    return frames.at(-1)[1];
  };

  const getStoryProgress = () => {
    const rect = cinematicStory.getBoundingClientRect();
    const scrollable = Math.max(cinematicStory.offsetHeight - window.innerHeight, 1);
    return clamp(-rect.top / scrollable);
  };

  const setChapterState = (chapter, opacity, isActive, direction = 1) => {
    const hidden = 1 - opacity;
    chapter.style.setProperty("--chapter-opacity", opacity.toFixed(4));
    chapter.style.setProperty("--chapter-x", `${(hidden * direction * 18).toFixed(2)}px`);
    chapter.style.setProperty("--chapter-y", `${(hidden * 28).toFixed(2)}px`);
    chapter.style.setProperty("--chapter-scale", (0.985 + opacity * 0.015).toFixed(4));
    chapter.style.setProperty("--chapter-clip", `${(hidden * 8).toFixed(2)}%`);
    chapter.style.setProperty("--chapter-blur", `${(hidden * 2.2).toFixed(2)}px`);
    chapter.dataset.active = String(isActive);
    chapter.inert = !isActive;
    chapter.setAttribute("aria-hidden", String(!isActive));
  };

  // The continuous film has three additional disassembly passages. Background
  // motion slows while the independent product layers open and close.
  const remapFilm = (position) => {
    for (let index = 1; index < filmTimeline.length; index += 1) {
      const [end, to] = filmTimeline[index];
      const [start, from] = filmTimeline[index - 1];
      if (position <= end) return from + (to - from) * clamp((position - start) / (end - start));
    }
    return 1;
  };

  const renderBreakdowns = (position) => {
    let covering = 0;
    breakdowns.forEach(({element, start, parts, width, height}) => {
      const local = position - start;
      const opacity = range(local, 0, 0.026) * (1 - range(local, 0.136, 0.16));
      covering = Math.max(covering, opacity);
      element.style.opacity = opacity.toFixed(4);
      element.style.visibility = opacity > 0.001 ? 'visible' : 'hidden';
      element.inert = opacity < 0.75;
      element.setAttribute('aria-hidden', String(opacity < 0.75));
      if (opacity < 0.001) return;
      parts.forEach((part, index) => {
        const stagger = index * 0.002;
        const spread = range(local, 0.005 + stagger, 0.055 + stagger) *
          (1 - range(local, 0.112 + stagger, 0.151 + stagger));
        const labels = range(local, 0.038 + stagger, 0.064 + stagger) *
          (1 - range(local, 0.108, 0.13));
        const positions = compactView.matches
          ? [[25, 21], [75, 25], [25, 72], [75, 76]]
          : [[14, 34], [38, 62], [63, 29], [87, 58]];
        const [x, y] = positions[index];
        part.style.setProperty('--part-dx', `${((x - 50) * spread * width / 100).toFixed(2)}px`);
        part.style.setProperty('--part-dy', `${((y - 48) * spread * height / 100).toFixed(2)}px`);
        part.style.setProperty('--part-scale', (0.65 + spread * 0.35).toFixed(4));
        part.style.setProperty('--part-rotation', `${[-5, 3, -4, 6][index] * spread}deg`);
        part.style.setProperty('--label-opacity', labels.toFixed(4));
        part.style.zIndex = String(4 - index);
      });
    });
    return covering;
  };

  const renderFilm = (position) => {
    if (!pin || reducedMotion.matches) return;
    const progress = remapFilm(position);
    const detailCover = renderBreakdowns(position);

    const overviewOpacity = keyframed(progress, [
      [0, 1],
      [0.21, 1],
      [0.255, 0.88],
      [0.29, 0.42],
      [0.325, 0],
    ]);
    const overviewX = keyframed(progress, [
      [0, 0],
      [0.07, -0.25],
      [0.13, -1.45],
      [0.19, -3.55],
      [0.255, -6.2],
      [0.325, -7.1],
    ]);
    const overviewY = keyframed(progress, [
      [0, 0],
      [0.1, 0.08],
      [0.18, 0.5],
      [0.255, 1.45],
      [0.325, 1.75],
    ]);
    const overviewScale = keyframed(progress, [
      [0, 1],
      [0.05, 1],
      [0.11, 1.07],
      [0.17, 1.25],
      [0.225, 1.43],
      [0.275, 1.55],
      [0.325, 1.59],
    ]);

    const showersOpacity = keyframed(progress, [
      [0, 0],
      [0.235, 0],
      [0.275, 0.28],
      [0.31, 0.82],
      [0.34, 1],
      [0.395, 1],
      [0.435, 0.76],
      [0.475, 0.24],
      [0.505, 0],
    ]);
    const showersX = keyframed(progress, [
      [0.235, 10],
      [0.275, 6.5],
      [0.31, 2.2],
      [0.34, 0],
      [0.395, -1.1],
      [0.445, -4.5],
      [0.505, -11],
    ]);
    const showersY = keyframed(progress, [
      [0.235, 1.2],
      [0.34, 0],
      [0.42, -0.2],
      [0.505, -0.75],
    ]);
    const showersScale = keyframed(progress, [
      [0.235, 1.12],
      [0.285, 1.065],
      [0.34, 1],
      [0.395, 1.012],
      [0.445, 1.035],
      [0.505, 1.075],
    ]);

    const mirrorsOpacity = keyframed(progress, [
      [0, 0],
      [0.415, 0],
      [0.455, 0.3],
      [0.495, 0.82],
      [0.525, 1],
      [0.595, 1],
      [0.635, 0.74],
      [0.675, 0.22],
      [0.705, 0],
    ]);
    const mirrorsX = keyframed(progress, [
      [0.415, 10],
      [0.455, 6.8],
      [0.495, 2.4],
      [0.525, 0],
      [0.595, -1.2],
      [0.65, -5],
      [0.705, -11],
    ]);
    const mirrorsY = keyframed(progress, [
      [0.415, 0.8],
      [0.525, 0],
      [0.61, -0.15],
      [0.705, -0.6],
    ]);
    const mirrorsScale = keyframed(progress, [
      [0.415, 1.115],
      [0.47, 1.06],
      [0.525, 1],
      [0.595, 1.012],
      [0.65, 1.04],
      [0.705, 1.075],
    ]);

    const furnitureOpacity = keyframed(progress, [
      [0, 0],
      [0.615, 0],
      [0.655, 0.28],
      [0.695, 0.82],
      [0.725, 1],
      [0.82, 1],
      [0.865, 0.9],
      [0.92, 0.72],
      [1, 0.72],
    ]);
    const furnitureX = keyframed(progress, [
      [0.615, 10],
      [0.655, 6.5],
      [0.695, 2.1],
      [0.725, 0],
      [0.82, -0.8],
      [0.88, -2.2],
      [1, -3],
    ]);
    const furnitureY = keyframed(progress, [
      [0.615, 0.9],
      [0.725, 0],
      [0.84, -0.12],
      [1, -0.4],
    ]);
    const furnitureScale = keyframed(progress, [
      [0.615, 1.11],
      [0.67, 1.055],
      [0.725, 1],
      [0.82, 1.01],
      [0.9, 1.025],
      [1, 1.035],
    ]);
    const contactIn = keyframed(progress, [
      [0, 0],
      [0.805, 0],
      [0.855, 0.32],
      [0.905, 0.82],
      [0.945, 1],
    ]);

    pin.style.setProperty("--story-progress", position.toFixed(4));
    pin.style.setProperty("--overview-opacity", overviewOpacity.toFixed(4));
    pin.style.setProperty("--overview-x", `${overviewX.toFixed(3)}%`);
    pin.style.setProperty("--overview-y", `${overviewY.toFixed(3)}%`);
    pin.style.setProperty("--overview-scale", overviewScale.toFixed(4));

    pin.style.setProperty("--showers-opacity", showersOpacity.toFixed(4));
    pin.style.setProperty("--showers-x", `${showersX.toFixed(3)}%`);
    pin.style.setProperty("--showers-y", `${showersY.toFixed(3)}%`);
    pin.style.setProperty("--showers-scale", showersScale.toFixed(4));

    pin.style.setProperty("--mirrors-opacity", mirrorsOpacity.toFixed(4));
    pin.style.setProperty("--mirrors-x", `${mirrorsX.toFixed(3)}%`);
    pin.style.setProperty("--mirrors-y", `${mirrorsY.toFixed(3)}%`);
    pin.style.setProperty("--mirrors-scale", mirrorsScale.toFixed(4));

    pin.style.setProperty("--furniture-opacity", furnitureOpacity.toFixed(4));
    pin.style.setProperty("--furniture-x", `${furnitureX.toFixed(3)}%`);
    pin.style.setProperty("--furniture-y", `${furnitureY.toFixed(3)}%`);
    pin.style.setProperty("--furniture-scale", furnitureScale.toFixed(4));
    pin.style.setProperty("--contact-shade-opacity", (contactIn * 0.92).toFixed(4));
    pin.style.setProperty("--scroll-label-opacity", (1 - range(progress, 0.9, 0.97)).toFixed(4));

    const chapterOpacities = [
      1 - range(progress, 0.065, 0.17),
      windowed(progress, 0.265, 0.335, 0.4, 0.475),
      windowed(progress, 0.445, 0.525, 0.6, 0.675),
      windowed(progress, 0.645, 0.725, 0.805, 0.875),
      range(progress, 0.84, 0.925),
    ];
    const activeIndex =
      progress < 0.225 ? 0 : progress < 0.42 ? 1 : progress < 0.62 ? 2 : progress < 0.83 ? 3 : 4;

    chapters.forEach((chapter, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      setChapterState(chapter, (chapterOpacities[index] ?? 0) * (1 - detailCover), index === activeIndex && detailCover < 0.5, direction);
    });

    progressBar?.setAttribute("aria-valuenow", String(Math.round(position * 100)));
  };

  const renderReducedMotion = () => {
    breakdowns.forEach(({element, parts}) => {
      element.removeAttribute('style');
      element.inert = false;
      element.setAttribute('aria-hidden', 'false');
      parts.forEach(part => part.removeAttribute('style'));
    });
    chapters.forEach((chapter) => {
      chapter.style.removeProperty("--chapter-opacity");
      chapter.style.removeProperty("--chapter-x");
      chapter.style.removeProperty("--chapter-y");
      chapter.style.removeProperty("--chapter-scale");
      chapter.style.removeProperty("--chapter-clip");
      chapter.style.removeProperty("--chapter-blur");
      chapter.dataset.active = "true";
      chapter.inert = false;
      chapter.setAttribute("aria-hidden", "false");
    });
  };

  const animateFilm = (time) => {
    animationFrame = 0;
    if (reducedMotion.matches) {
      renderReducedMotion();
      return;
    }

    const elapsed = lastFrameTime ? Math.min(time - lastFrameTime, 34) : 16.67;
    lastFrameTime = time;
    const damping = 1 - Math.pow(0.92, elapsed / 16.67);
    filmProgress += (targetProgress - filmProgress) * damping;

    if (Math.abs(targetProgress - filmProgress) < 0.00008) {
      filmProgress = targetProgress;
    }

    renderFilm(filmProgress);

    if (filmProgress !== targetProgress) {
      animationFrame = window.requestAnimationFrame(animateFilm);
    } else {
      lastFrameTime = 0;
    }
  };

  const requestFilmFrame = () => {
    if (!animationFrame) animationFrame = window.requestAnimationFrame(animateFilm);
  };

  const syncScrollTarget = (immediate = false) => {
    if (immediate) breakdowns.forEach(stage => {
      stage.width = stage.area.clientWidth;
      stage.height = stage.area.clientHeight;
    });
    if (reducedMotion.matches) {
      window.clearTimeout(snapTimer);
      window.clearTimeout(snapReleaseTimer);
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      renderReducedMotion();
      return;
    }
    targetProgress = getStoryProgress();
    if (immediate || reducedMotion.matches) {
      filmProgress = targetProgress;
      renderFilm(filmProgress);
      return;
    }
    requestFilmFrame();
  };

  const scrollToProgress = (target, behavior = "smooth") => {
    if (reducedMotion.matches) return;
    const storyTop = window.scrollY + cinematicStory.getBoundingClientRect().top;
    const scrollable = Math.max(cinematicStory.offsetHeight - window.innerHeight, 1);
    window.scrollTo({
      top: storyTop + clamp(target) * scrollable,
      behavior,
    });
  };

  const releaseMagnet = () => {
    window.clearTimeout(snapReleaseTimer);
    snapReleaseTimer = window.setTimeout(() => {
      isMagnetizing = false;
    }, 900);
  };

  const startMagneticScroll = (target, behavior = "smooth") => {
    window.clearTimeout(snapTimer);
    isMagnetizing = true;
    scrollToProgress(target, behavior);
    releaseMagnet();
  };

  // Navigation selects a scene directly; only manual scrolling plays the film.
  const jumpToScene = (target) => {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastFrameTime = 0;
    startMagneticScroll(target, "instant");
    syncScrollTarget(true);
  };

  const scheduleGentleMagnet = () => {
    window.clearTimeout(snapTimer);
    if (reducedMotion.matches || isMagnetizing || isTouching) return;

    const rect = cinematicStory.getBoundingClientRect();
    if (rect.top > 1 || rect.bottom < window.innerHeight - 1) return;

    snapTimer = window.setTimeout(() => {
      const progress = getStoryProgress();
      const nearest = storyStops.reduce((best, stop) =>
        Math.abs(stop - progress) < Math.abs(best - progress) ? stop : best,
      );
      const distance = Math.abs(nearest - progress);
      // Touch scrolling settles on a complete scene, even between distant stops.
      if (distance > 0.001 && (compactView.matches || distance <= magneticDistance && distance > 0.008)) {
        startMagneticScroll(nearest);
      }
    }, compactView.matches ? 180 : 800);
  };

  jumpLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = Number.parseFloat(link.dataset.storyJump || "");
      if (!Number.isFinite(target)) return;

      if (reducedMotion.matches) {
        document.querySelector(link.getAttribute("href"))?.scrollIntoView({ behavior: "auto" });
        return;
      }

      event.preventDefault();
      const href = link.getAttribute("href");
      if (href?.startsWith("#")) window.history.replaceState(null, "", href);
      jumpToScene(target);
    });
  });

  const cancelMagnet = () => {
    window.clearTimeout(snapTimer);
    if (!isMagnetizing) return;
    window.scrollTo({top: window.scrollY, behavior: 'instant'});
    window.clearTimeout(snapReleaseTimer);
    isMagnetizing = false;
  };

  window.addEventListener(
    "scroll",
    () => {
      syncScrollTarget();
      scheduleGentleMagnet();
    },
    { passive: true },
  );
  window.addEventListener("wheel", cancelMagnet, { passive: true });
  window.addEventListener("touchstart", () => {
    isTouching = true;
    cancelMagnet();
  }, { passive: true });
  const finishTouch = () => {
    isTouching = false;
    scheduleGentleMagnet();
  };
  window.addEventListener("touchend", finishTouch, { passive: true });
  window.addEventListener("touchcancel", finishTouch, { passive: true });
  window.addEventListener("keydown", event => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) cancelMagnet();
  });
  window.addEventListener("resize", () => syncScrollTarget(true));
  reducedMotion.addEventListener?.("change", () => syncScrollTarget(true));

  syncScrollTarget(true);

  const initialJump = jumpLinks.find((link) => link.getAttribute("href") === window.location.hash);
  if (initialJump && !reducedMotion.matches) {
    window.requestAnimationFrame(() => {
      jumpToScene(Number.parseFloat(initialJump.dataset.storyJump || "0"));
    });
  }
}
