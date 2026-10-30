import Combine
import CoreLocation
import Foundation

private struct VisitProject: Codable {
    let id: Int
    let title: String
    let address: String
    let phone: String?
    let clientName: String?
    let entrance: String?
    let floor: String?
    let apartment: String?
    let latitude: Double
    let longitude: Double

    var location: CLLocation { CLLocation(latitude: latitude, longitude: longitude) }
}

final class VisitProximityManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = VisitProximityManager()

    @Published private(set) var isEnabled: Bool
    @Published var pendingProjectID: Int?
    @Published private(set) var visitOpenSequence = 0

    private let locationManager = CLLocationManager()
    private let projectsKey = "ceh.visit.projects.v1"
    private let enabledKey = "ceh.visit.enabled.v1"
    private let radius: CLLocationDistance = 3_000
    private var projects: [VisitProject]
    private var locationRequestPending = false
    private var lastPresentedProjectID: Int?
    private var lastPresentedAt: Date?

    private override init() {
        let defaults = UserDefaults.standard
        isEnabled = defaults.object(forKey: enabledKey) == nil ? true : defaults.bool(forKey: enabledKey)
        projects = (defaults.data(forKey: projectsKey)
            .flatMap { try? JSONDecoder().decode([VisitProject].self, from: $0) }) ?? []
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        stopLegacyBackgroundMonitoring()
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: enabledKey)
        if enabled { checkNearbyOnAppOpen() }
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
            let phone = (row["phone"] as? String).map { String($0.prefix(50)) }
            let clientName = (row["clientName"] as? String).map { String($0.prefix(100)) }
            let entrance = (row["entrance"] as? String).map { String($0.prefix(30)) }
            let floor = (row["floor"] as? String).map { String($0.prefix(30)) }
            let apartment = (row["apartment"] as? String).map { String($0.prefix(30)) }
            return VisitProject(id: id, title: String(title.prefix(100)),
                                address: String(address.prefix(300)), phone: phone,
                                clientName: clientName, entrance: entrance,
                                floor: floor, apartment: apartment,
                                latitude: latitude, longitude: longitude)
        }
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: projectsKey)
        }
        checkNearbyOnAppOpen()
    }

    func clear() {
        projects = []
        UserDefaults.standard.removeObject(forKey: projectsKey)
        locationRequestPending = false
    }

    func checkNearbyOnAppOpen() {
        guard isEnabled, !projects.isEmpty, !locationRequestPending else { return }
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationRequestPending = true
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationRequestPending = true
            locationManager.requestLocation()
        default:
            locationRequestPending = false
        }
    }

    private func stopLegacyBackgroundMonitoring() {
        for region in locationManager.monitoredRegions where region.identifier.hasPrefix("ceh-visit-") {
            locationManager.stopMonitoring(for: region)
        }
        locationManager.stopMonitoringSignificantLocationChanges()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isEnabled else {
            locationRequestPending = false
            return
        }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            locationRequestPending = true
            manager.requestLocation()
        case .notDetermined:
            break
        default:
            locationRequestPending = false
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        locationRequestPending = false
        guard isEnabled, let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        guard let nearby = projects.min(by: {
            location.distance(from: $0.location) < location.distance(from: $1.location)
        }) else { return }
        guard location.distance(from: nearby.location) <= radius else { return }
        showNearbyProject(nearby)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locationRequestPending = false
    }

    private func showNearbyProject(_ project: VisitProject) {
        let now = Date()
        // Avoid the duplicate check caused by page sync + scene activation, but
        // show the visit card again on the next real app opening.
        if lastPresentedProjectID == project.id, let previous = lastPresentedAt,
           now.timeIntervalSince(previous) < 60 { return }
        lastPresentedProjectID = project.id
        lastPresentedAt = now

        DispatchQueue.main.async {
            self.pendingProjectID = project.id
            self.visitOpenSequence += 1
        }
    }
}
