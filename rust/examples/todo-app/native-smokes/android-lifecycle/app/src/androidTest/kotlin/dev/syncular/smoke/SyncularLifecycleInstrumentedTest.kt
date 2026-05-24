package dev.syncular.smoke

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SyncularLifecycleInstrumentedTest {
    @Test
    fun syncularNativeLifecycleInsideAndroidApp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SyncularAndroidLifecycleScenario.run(context)
    }
}
