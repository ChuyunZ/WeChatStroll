const { mockRoutes } = require("../miniprogram/data/mock-routes");

let pageDefinition;
let page;

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function loadRoutesPage() {
  jest.resetModules();

  pageDefinition = null;

  // Mock WeChat's global Page function.
  global.Page = jest.fn((definition) => {
    pageDefinition = definition;
  });

  // Mock WeChat APIs used by routes.js.
  global.wx = {
    navigateTo: jest.fn(),
    redirectTo: jest.fn(),
    showToast: jest.fn()
  };

  require("../miniprogram/pages/routes/routes");

  const pageInstance = {
    ...pageDefinition,
    data: {
      ...pageDefinition.data
    }
  };

  // Mock WeChat Page.setData().
  pageInstance.setData = jest.fn((updates) => {
    pageInstance.data = {
      ...pageInstance.data,
      ...updates
    };
  });

  return pageInstance;
}

beforeEach(() => {
  page = loadRoutesPage();
});

afterEach(() => {
  jest.restoreAllMocks();
});


describe("Routes page state handling", () => {
  test("loadRoutes starts in loading state", async () => {
    const deferred = createDeferred();

    page.data.routeState = "success";
    page.data.routes = mockRoutes;

    page.getRoutes = jest.fn(() => deferred.promise);

    const loadPromise = page.loadRoutes();

    expect(page.data.routeState).toBe("loading");
    expect(page.data.routes).toEqual([]);

    deferred.resolve(mockRoutes);

    await loadPromise;
  });


  test("loadRoutes sets success when routes exist", async () => {
    page.getRoutes = jest.fn().mockResolvedValue(mockRoutes);

    await page.loadRoutes();

    expect(page.data.routeState).toBe("success");
    expect(page.data.routes.length).toBe(mockRoutes.length);
    expect(page.data.routes.length).toBeGreaterThan(0);
  });


  test("loadRoutes sets empty when no routes exist", async () => {
    page.getRoutes = jest.fn().mockResolvedValue([]);

    await page.loadRoutes();

    expect(page.data.routeState).toBe("empty");
    expect(page.data.routes).toEqual([]);
  });


  test("loadRoutes sets error when request fails", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    page.getRoutes = jest
      .fn()
      .mockRejectedValue(new Error("Mock route loading failed"));

    await page.loadRoutes();

    expect(page.data.routeState).toBe("error");
    expect(page.data.routes).toEqual([]);

    expect(consoleErrorSpy).toHaveBeenCalled();
  });


  test("retryLoadRoutes uses the normal loadRoutes flow", () => {
    page.loadRoutes = jest.fn();

    page.retryLoadRoutes();

    expect(page.loadRoutes).toHaveBeenCalledTimes(1);
  });


  test("stale success cannot overwrite a newer success", async () => {
    const firstRequest = createDeferred();
    const secondRequest = createDeferred();

    const oldRoutes = [
      {
        ...mockRoutes[0],
        title: "旧请求路线"
      }
    ];

    const newRoutes = [
      {
        ...mockRoutes[0],
        title: "最新请求路线"
      }
    ];

    page.getRoutes = jest
      .fn()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    // Request 1 starts first.
    const oldLoadPromise = page.loadRoutes();

    // Request 2 starts later and should become authoritative.
    const newLoadPromise = page.loadRoutes();

    // Newer request finishes first.
    secondRequest.resolve(newRoutes);

    await newLoadPromise;

    expect(page.data.routeState).toBe("success");
    expect(page.data.routes[0].title).toBe("最新请求路线");

    // Older request finishes afterwards.
    firstRequest.resolve(oldRoutes);

    await oldLoadPromise;

    // Old result must NOT overwrite the newer one.
    expect(page.data.routeState).toBe("success");
    expect(page.data.routes[0].title).toBe("最新请求路线");
  });


  test("stale error cannot overwrite a newer success", async () => {
    const firstRequest = createDeferred();
    const secondRequest = createDeferred();

    const newRoutes = [
      {
        ...mockRoutes[0],
        title: "最新请求路线"
      }
    ];

    page.getRoutes = jest
      .fn()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    // Old request starts.
    const oldLoadPromise = page.loadRoutes();

    // New request starts afterwards.
    const newLoadPromise = page.loadRoutes();

    // New request succeeds first.
    secondRequest.resolve(newRoutes);

    await newLoadPromise;

    expect(page.data.routeState).toBe("success");
    expect(page.data.routes[0].title).toBe("最新请求路线");

    // Old request fails afterwards.
    firstRequest.reject(new Error("Old request failed"));

    await oldLoadPromise;

    // Old error must NOT overwrite the newer success state.
    expect(page.data.routeState).toBe("success");
    expect(page.data.routes[0].title).toBe("最新请求路线");
  });


  test("viewRoute navigates to the correct Route Detail page", () => {
    const routeId = mockRoutes[0].routeId;

    page.viewRoute({
      currentTarget: {
        dataset: {
          id: routeId
        }
      }
    });

    expect(wx.navigateTo).toHaveBeenCalledTimes(1);

    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/pages/route-detail/route-detail?id=${routeId}`
    });
  });


  test("showOtherRoutes rotates the route order", () => {
    page.data.routes = [
      { routeId: "route-a" },
      { routeId: "route-b" },
      { routeId: "route-c" }
    ];

    page.showOtherRoutes();

    expect(page.data.routes).toEqual([
      { routeId: "route-b" },
      { routeId: "route-c" },
      { routeId: "route-a" }
    ]);

    expect(wx.showToast).toHaveBeenCalledWith({
      title: "已更换路线",
      icon: "none"
    });
  });


  test("onUnload invalidates an in-flight route request", async () => {
    const deferred = createDeferred();

    page.getRoutes = jest.fn(() => deferred.promise);

    const loadPromise = page.loadRoutes();

    expect(page.data.routeState).toBe("loading");

    // Simulate leaving the Routes page while request is still running.
    page.onUnload();

    deferred.resolve(mockRoutes);

    await loadPromise;

    // Only the initial loading setData should have happened.
    // The stale request must not update the destroyed page.
    expect(page.setData).toHaveBeenCalledTimes(1);
  });
});