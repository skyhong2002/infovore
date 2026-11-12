package tw.skyhong.infovore.health.robo

import android.app.Application
import android.util.Log
import androidx.health.connect.client.testing.FakeHealthConnectClient
import androidx.health.connect.client.testing.FakePermissionController
import androidx.lifecycle.ViewModelProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.flow.MutableStateFlow
import tw.skyhong.infovore.health.EndpointPolicy
import tw.skyhong.infovore.health.HealthConnectAccess
import tw.skyhong.infovore.health.SyncCoordinator
import tw.skyhong.infovore.health.SyncEnvironment
import tw.skyhong.infovore.health.SyncRunner
import tw.skyhong.infovore.health.SyncState
import tw.skyhong.infovore.health.InfovoreHealthApp
import tw.skyhong.infovore.health.screen.ObservationQueue

/**
 * The Robolectric application (robolectric.properties): Robolectric does not run the androidx
 * start-up provider that initialises WorkManager, so this initialises a test WorkManager first,
 * then runs the app's real start-up ([InfovoreHealthApp.start], which schedules both workers).
 *
 * Robolectric creates a fresh application, with fresh files and preferences, for every test but
 * keeps the classes (and so process-wide singletons) loaded; per-test state is reset here.
 */
class TestInfovoreApp : Application() {
    override fun onCreate() {
        super.onCreate()
        FakeAndroidKeyStore.install()
        // The queue singleton would otherwise keep the previous test's files directory.
        ObservationQueue::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        // Process-wide test seams and the shared sync state would otherwise leak from the previous test.
        EndpointPolicy.testHttpHost = null
        SyncEnvironment.testClock = null
        SyncEnvironment.testSyncIds = null
        SyncEnvironment.testApiTiming = null
        SyncCoordinator::class.java.getDeclaredField("_state").apply { isAccessible = true }
            .let { @Suppress("UNCHECKED_CAST") (it.get(SyncRunner.coordinator) as MutableStateFlow<SyncState>).value = SyncState() }
        // AndroidViewModelFactory.getInstance() keeps the first Application it saw (one per process
        // on a device); here it would hand MainViewModel the previous test's application.
        ViewModelProvider.AndroidViewModelFactory::class.java.getDeclaredField("_instance").apply { isAccessible = true }.set(null, null)
        // Health Connect does not exist under Robolectric: a fake with no permissions granted.
        HealthConnectAccess.testClient = FakeHealthConnectClient(permissionController = FakePermissionController(grantAll = false))
        WorkManagerTestInitHelper.initializeTestWorkManager(
            this,
            Configuration.Builder().setMinimumLoggingLevel(Log.DEBUG).setExecutor(SynchronousExecutor()).build(),
        )
        InfovoreHealthApp.start(this)
    }
}
