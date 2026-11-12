package de.crazybatto.robotschichtlog;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** All active transfers run serially, even if the safety job and an immediate job overlap. */
public final class NasUploadJob extends JobService {
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, Run> jobs = new HashMap<>();

    private static final class Run {
        Future<?> task;
    }

    @Override public boolean onStartJob(JobParameters params) {
        int id = params.getJobId();
        Run run = new Run();
        jobs.put(id, run);
        run.task = WORKER.submit(() -> {
            boolean retry = true;
            try {
                // Small order snapshots must not wait behind large photo uploads.
                retry = RobotOrderSync.run(getApplicationContext());
                if (!Thread.currentThread().isInterrupted()) {
                    OrderPhotos.recoverForUpload(getApplicationContext());
                    retry = NasSync.uploadPending(getApplicationContext()) || retry;
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                retry = true;
            } catch (Exception unavailable) {
                retry = true;
            } finally {
                boolean requestRetry = retry;
                main.post(() -> {
                    if (jobs.get(id) == run) {
                        jobs.remove(id);
                        jobFinished(params, requestRetry);
                    }
                });
            }
        });
        return true;
    }

    @Override public boolean onStopJob(JobParameters params) {
        Run run = jobs.remove(params.getJobId());
        if (run != null) run.task.cancel(true);
        return true;
    }
}
