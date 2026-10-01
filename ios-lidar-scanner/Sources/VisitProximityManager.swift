import Combine
import CoreLocation
import Foundation
import UserNotifications

private struct VisitProject: Codable {
    let id: Int
    let title: String
    let address: String
    let latitude: Double
    let longitude: Double

    var location: CLLocation { CLLocation(latitude: latitude, longitude: longitude) }
    var regionID: String { "ceh-visit-\(id)" }
}

final class VisitProximityManager: NSObject, ObservableObject, CLLocationManagerDelegate, UNUserNotificationCenterDelegate {
    static let shared = VisitProximityManager()

    @Published private(set) var isEnabled: Bool
    @Published var pendingProjectID: Int?
    @Published private(set) var visitOpenSequence = 0

    private let locationManager = CLLocationManager()
    private let notificationCenter = UNUserNotificationCenter.current()
    private let projectsKey = "ceh.visit.projects.v1"
    private let enabledKey = "ceh.visit.enabled.v1"
    private let alertPrefix = "ceh.visit.lastAlert."
    private let radius: CLLocationDistance = 180
    private var projects: [VisitProject]

    private override init() {
        isEnabled = UserDefaults.standard.bool(forKey: enabledKey)
        projects = (UserDefaults.standard.data(forKey: projectsKey)
            .flatMap { try? JSONDecoder().decode([VisitProject].self, from: $0) }) ?? []
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        notificationCenter.delegate = self
        if isEnabled { refreshMonitoring() }
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: enabledKey)
        if !enabled {
            stopMonitoring()
            return
        }
        notificationCenter.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
        switch locationManager.authorizationStatus {
        case .notDetermined: locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: locationManager.requestAlwaysAuthorization()
        case .authorizedAlways: refreshMonitoring()
        default: break
        }
    }

    func sync(_ rows: [[String: Any]]) {
        projects = rows.compactMap { row in
            guard let id = row["id"] as? Int, id > 0,
                  let title = row["title"] as? String,
                  let address = row["address"] as? String, !address.isEmpty,
                  let latitude = row["lat"] as? Double,
                  let longitude = row["lon"] as? Double,
                  latitude.isFinite, longitude.isFinite,
                  (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
            return VisitProject(id: id, title: String(title.prefix(100)),
                                address: String(address.prefix(300)), latitude: latitude, longitude: longitude)
        }
        if let data = try? JSONEncoder().encode(projects) { UserDefaults.standard.set(data, forKey: projectsKey) }
        if isEnabled, locationManager.authorizationStatus == .authorizedAlways { locationManager.requestLocation() }
        refreshMonitoring()
    }

    func clear() {
        projects = []
        UserDefaults.standard.removeObject(forKey: projectsKey)
        stopMonitoring()
    }

    private func stopMonitoring() {
        for region in locationManager.monitoredRegions where region.identifier.hasPrefix("ceh-visit-") {
            locationManager.stopMonitoring(for: region)
        }
        locationManager.stopMonitoringSignificantLocationChanges()
    }

    private func refreshMonitoring() {
        guard isEnabled, locationManager.authorizationStatus == .authorizedAlways,
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else {
            stopMonitoring()
            return
        }
        guard !projects.isEmpty else {
            stopMonitoring()
            return
        }
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            locationManager.startMonitoringSignificantLocationChanges()
        }
        if locationManager.location == nil { locationManager.requestLocation() }
        let origin = locationManager.location
        // iOS allows at most 20 monitored regions per app. Keep the nearest current objects.
        let selected = Array(projects.sorted {
            (origin?.distance(from: $0.location) ?? 0) < (origin?.distance(from: $1.location) ?? 0)
        }.prefix(20))
        let wanted = Dictionary(uniqueKeysWithValues: selected.map { ($0.regionID, $0) })
        var active = Set<String>()
        for region in locationManager.monitoredRegions where region.identifier.hasPrefix("ceh-visit-") {
            guard let project = wanted[region.identifier], let circular = region as? CLCircularRegion,
                  abs(circular.center.latitude - project.latitude) < 0.000001,
                  abs(circular.center.longitude - project.longitude) < 0.000001 else {
                locationManager.stopMonitoring(for: region)
                continue
            }
            active.insert(region.identifier)
        }
        for project in selected where !active.contains(project.regionID) {
            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: project.latitude,
                                                                         longitude: project.longitude),
                                          radius: radius, identifier: project.regionID)
            region.notifyOnEntry = true
            region.notifyOnExit = false
            locationManager.startMonitoring(for: region)
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if isEnabled, manager.authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        refreshMonitoring()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        refreshMonitoring()
        guard isEnabled, manager.authorizationStatus == .authorizedAlways,
              let location = locations.last, location.horizontalAccuracy >= 0,
              location.horizontalAccuracy <= 100 else { return }
        if let nearby = projects.min(by: { location.distance(from: $0.location) < location.distance(from: $1.location) }),
           location.distance(from: nearby.location) <= radius {
            notifyIfNeeded(nearby)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Existing geofences remain active even when a one-shot location fix fails.
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard isEnabled, let project = projects.first(where: { $0.regionID == region.identifier }) else { return }
        notifyIfNeeded(project)
    }

    private func notifyIfNeeded(_ project: VisitProject) {
        guard isEnabled else { return }
        notificationCenter.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            DispatchQueue.main.async { self.scheduleNotificationIfNeeded(project) }
        }
    }

    private func scheduleNotificationIfNeeded(_ project: VisitProject) {
        guard isEnabled else { return }
        let key = alertPrefix + String(project.id)
        let now = Date()
        if let previous = UserDefaults.standard.object(forKey: key) as? Date,
           now.timeIntervalSince(previous) < 12 * 60 * 60 { return }
        UserDefaults.standard.set(now, forKey: key)
        let content = UNMutableNotificationContent()
        content.title = "Вы рядом с объектом"
        content.body = "\(project.title) · \(project.address)"
        content.sound = .default
        content.userInfo = ["visitProjectID": project.id]
        notificationCenter.add(UNNotificationRequest(identifier: "ceh-visit-\(project.id)-\(Int(now.timeIntervalSince1970))",
                                                     content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["visitProjectID"] as? Int {
            DispatchQueue.main.async {
                self.pendingProjectID = id
                self.visitOpenSequence += 1
            }
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
